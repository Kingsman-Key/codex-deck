import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} from "electron";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ContextHandoffResult,
  ProfileInput,
  ProfileView,
} from "../src/shared/types";
import { ProfileStore } from "./profile-store";
import { findDesktopExecutable, ProfileLauncher } from "./launcher";
import {
  importCcSwitchProviders,
  refreshCcSwitchAuth,
  scanCcSwitch,
} from "./cc-switch-importer";
import {
  exists,
  getProfilePaths,
  importCurrentAuth,
  prepareProfileRuntime,
} from "./profile-runtime";
import {
  buildLatestContext,
  exportProfileHistory,
  migrateProfileHistory,
  resolveProviderTag,
  syncProfileHistoryFromMaster,
  transferProfileHistory,
} from "./history-migration";

let mainWindow: BrowserWindow | null = null;
let profileStore: ProfileStore;
let launcher: ProfileLauncher;
let dataRoot: string;
let baseCodexHome: string;

interface Settings {
  desktopExecutable?: string;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    title: "Codex Deck",
    backgroundColor: "#0b0d0c",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) void mainWindow.loadURL(developmentUrl);
  else void mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function emitProfilesChanged(): void {
  mainWindow?.webContents.send("profiles:changed");
}

async function getSettings(): Promise<Settings> {
  try {
    return JSON.parse(
      await readFile(path.join(dataRoot, "settings.json"), "utf8"),
    ) as Settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  await writeFile(
    path.join(dataRoot, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function resolveExecutable(): Promise<string | null> {
  return findDesktopExecutable((await getSettings()).desktopExecutable);
}

async function handoffContext(
  sourceId: string,
  targetId: string,
): Promise<ContextHandoffResult> {
  if (sourceId === targetId) {
    throw new Error("请选择两个不同的配置。");
  }
  const sourceProfile = await profileStore.get(sourceId);
  const targetProfile = await profileStore.get(targetId);
  if (targetProfile.runtimeMode === "native") {
    throw new Error("“当前 Codex”不能作为上下文接收目标。");
  }

  const executable = await resolveExecutable();
  if (!executable) {
    throw new Error("没有找到 Codex / ChatGPT 桌面应用。");
  }
  const sourceHome =
    sourceProfile.runtimeMode === "native"
      ? baseCodexHome
      : getProfilePaths(profileStore.profilesDir, sourceProfile.id).codexHome;
  const sourceTag = await resolveProviderTag(
    path.join(sourceHome, "config.toml"),
    sourceProfile,
  );
  const context = await buildLatestContext({
    sourceCodexHome: sourceHome,
    providerTag: sourceTag,
  });
  clipboard.writeText(context);

  const paths = await prepareProfileRuntime(
    profileStore.profilesDir,
    baseCodexHome,
    targetProfile,
  );
  const apiKey = await profileStore.getSecret(targetId);
  const credentialKind =
    targetProfile.credentialKind ??
    (targetProfile.provider === "chatgpt" ? "oauth" : "api-key");
  if (credentialKind === "api-key" && !apiKey) {
    throw new Error("目标 API 配置还没有保存 API Key。");
  }
  const targetResult = await launcher.launch(
    targetProfile,
    executable,
    paths,
    apiKey,
  );

  return {
    sourceName: sourceProfile.name,
    targetName: targetProfile.name,
    targetStatus: targetResult.status,
    contextLength: context.length,
  };
}

async function listProfileViews(): Promise<ProfileView[]> {
  const profiles = await profileStore.list();
  return Promise.all(
    profiles.map(async (profile) => ({
      ...profile,
      running: launcher.isRunning(profile.id),
      hasApiKey: await profileStore.hasSecret(profile.id),
    })),
  );
}

function registerIpc(): void {
  ipcMain.handle("profiles:list", listProfileViews);

  ipcMain.handle("profiles:save", async (_event, input: ProfileInput) => {
    if (input.importCurrentSession) {
      const sourceAuth = path.join(baseCodexHome, "auth.json");
      if (!(await exists(sourceAuth))) {
        throw new Error("当前 Codex Home 中没有可导入的 auth.json；请直接启动后登录一次。");
      }
    }
    const profile = await profileStore.save(input);
    const paths = await prepareProfileRuntime(
      profileStore.profilesDir,
      baseCodexHome,
      profile,
    );
    if (input.importCurrentSession) {
      await importCurrentAuth(baseCodexHome, paths.codexHome);
    }
    emitProfilesChanged();
    return (await listProfileViews()).find((entry) => entry.id === profile.id);
  });

  ipcMain.handle("profiles:delete", async (_event, id: string) => {
    if (launcher.isRunning(id)) {
      throw new Error("这个配置仍在运行，请先退出对应窗口。");
    }
    const profile = await profileStore.get(id);
    if (profile.runtimeMode === "native") {
      throw new Error("“当前 Codex”是保留原聊天与登录的系统入口，不能删除。");
    }
    const directory = profileStore.profileDirectory(id);
    if (await exists(directory)) await shell.trashItem(directory);
    await profileStore.remove(id);
    emitProfilesChanged();
  });

  ipcMain.handle("profiles:launch", async (_event, id: string) => {
    const executable = await resolveExecutable();
    if (!executable) {
      throw new Error("没有找到 Codex / ChatGPT 桌面应用，请先在设置中选择可执行文件。");
    }
    const profile = await profileStore.get(id);
    const paths = await prepareProfileRuntime(
      profileStore.profilesDir,
      baseCodexHome,
      profile,
    );
    const apiKey = await profileStore.getSecret(id);
    const credentialKind =
      profile.credentialKind ??
      (profile.provider === "chatgpt" ? "oauth" : "api-key");
    if (credentialKind === "api-key" && !apiKey) {
      throw new Error("这个 API 配置还没有保存 API Key。");
    }
    return launcher.launch(profile, executable, paths, apiKey);
  });

  ipcMain.handle("profiles:quit", async (_event, id: string) => {
    await launcher.quit(id);
  });

  ipcMain.handle("profiles:migrate-history", async (_event, id: string) => {
    if (launcher.isRunning(id)) {
      throw new Error("这个配置仍在运行，请先退出对应窗口再迁移历史。");
    }
    const profile = await profileStore.get(id);
    return migrateProfileHistory({
      profile,
      profilesDir: profileStore.profilesDir,
      baseCodexHome,
    });
  });

  ipcMain.handle("profiles:sync-history", async (_event, id: string) => {
    if (launcher.isRunning(id)) {
      throw new Error("这个配置仍在运行，请先退出对应窗口再同步历史。");
    }
    const profile = await profileStore.get(id);
    return syncProfileHistoryFromMaster({
      profile,
      profilesDir: profileStore.profilesDir,
      baseCodexHome,
    });
  });

  ipcMain.handle(
    "profiles:transfer-history",
    async (_event, sourceId: string, targetId: string) => {
      if (sourceId === targetId) {
        throw new Error("请选择两个不同的配置。");
      }
      if (
        launcher.isRunning(sourceId) ||
        launcher.isRunning(targetId)
      ) {
        throw new Error("来源或目标配置仍在运行，请先退出对应窗口。");
      }
      const sourceProfile = await profileStore.get(sourceId);
      const targetProfile = await profileStore.get(targetId);
      return transferProfileHistory({
        sourceProfile,
        targetProfile,
        profilesDir: profileStore.profilesDir,
        baseCodexHome,
      });
    },
  );

  ipcMain.handle("profiles:export-history", async (_event, id: string) => {
    if (launcher.isRunning(id)) {
      throw new Error("这个配置仍在运行，请先退出对应窗口再导出历史。");
    }
    const profile = await profileStore.get(id);
    return exportProfileHistory({
      profile,
      profilesDir: profileStore.profilesDir,
      baseCodexHome,
    });
  });

  ipcMain.handle("profiles:refresh-cc-switch-auth", async (_event, id: string) => {
    if (launcher.isRunning(id)) {
      throw new Error("这个配置仍在运行，请先退出对应窗口再重新注入登录态。");
    }
    const profile = await profileStore.get(id);
    return refreshCcSwitchAuth({
      profile,
      profileStore,
      baseCodexHome,
    });
  });

  ipcMain.handle(
    "profiles:handoff-context",
    async (_event, sourceId: string, targetId: string) => {
      return handoffContext(sourceId, targetId);
    },
  );

  ipcMain.handle("system:status", async () => ({
    platform: process.platform,
    desktopExecutable: await resolveExecutable(),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    dataRoot,
    codexHome: baseCodexHome,
  }));

  ipcMain.handle("cc-switch:scan", async () =>
    scanCcSwitch(await profileStore.list()),
  );

  ipcMain.handle("cc-switch:import", async (_event, sourceIds: unknown) => {
    if (
      !Array.isArray(sourceIds) ||
      sourceIds.length > 100 ||
      !sourceIds.every(
        (sourceId) => typeof sourceId === "string" && sourceId.length <= 200,
      )
    ) {
      throw new Error("CC Switch 导入选择无效。");
    }
    const result = await importCcSwitchProviders({
      sourceIds,
      profileStore,
      baseCodexHome,
    });
    const views = await listProfileViews();
    const importedIds = new Set(result.imported.map((profile) => profile.id));
    emitProfilesChanged();
    return {
      imported: views.filter((profile) => importedIds.has(profile.id)),
      skipped: result.skipped,
    };
  });

  ipcMain.handle("system:choose-executable", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "选择 Codex / ChatGPT 可执行文件",
      properties: ["openFile"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const desktopExecutable = result.filePaths[0];
    await saveSettings({ ...(await getSettings()), desktopExecutable });
    return desktopExecutable;
  });

  ipcMain.handle("system:open-data-folder", async () => {
    await shell.openPath(dataRoot);
  });
}

app.whenReady().then(async () => {
  dataRoot = path.join(app.getPath("userData"), "state");
  baseCodexHome =
    process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  profileStore = new ProfileStore(dataRoot, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  await profileStore.initialize();
  const nativeProfile = await profileStore.ensureNativeProfile();
  await profileStore.enableAutoSyncForImportedProfiles();
  await profileStore.normalizeDeepSeekProfiles();
  launcher = new ProfileLauncher(emitProfilesChanged);
  const desktopExecutable = await resolveExecutable();
  const profiles = await profileStore.list();
  if (desktopExecutable) {
    await launcher.recoverProcesses(
      profiles,
      desktopExecutable,
      profileStore.profilesDir,
    );
  }
  let didContextHandoff = false;
  for (const profile of profiles) {
    if (profile.runtimeMode === "native" || launcher.isRunning(profile.id)) {
      continue;
    }
    if (profile.autoSync === "context" && !didContextHandoff) {
      didContextHandoff = true;
      await handoffContext(nativeProfile.id, profile.id).catch(() => undefined);
    }
    if (profile.autoSync === "history") {
      await syncProfileHistoryFromMaster({
        profile,
        profilesDir: profileStore.profilesDir,
        baseCodexHome,
      }).catch(() => undefined);
    }
  }
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
