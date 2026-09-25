import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Profile } from "../src/shared/types";
import { generateProfileConfig } from "./config-generator";
import {
  DEEPSEEK_MODEL_CATALOG_FILENAME,
  serializeDeepSeekModelCatalog,
} from "./deepseek-model-catalog";

const DEEPSEEK_DESKTOP_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "max",
];

export interface ProfilePaths {
  root: string;
  codexHome: string;
  browserData: string;
}

export function getProfilePaths(profilesDir: string, id: string): ProfilePaths {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("配置 ID 无效。");
  const root = path.join(profilesDir, id);
  return {
    root,
    codexHome: path.join(root, "codex-home"),
    browserData: path.join(root, "browser-data"),
  };
}

export async function prepareProfileRuntime(
  profilesDir: string,
  baseCodexHome: string,
  profile: Profile,
): Promise<ProfilePaths> {
  if (profile.runtimeMode === "native") {
    return {
      root: baseCodexHome,
      codexHome: baseCodexHome,
      browserData: "",
    };
  }

  const paths = getProfilePaths(profilesDir, profile.id);
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await mkdir(paths.browserData, { recursive: true, mode: 0o700 });
  const configPath = path.join(paths.codexHome, "config.toml");
  const importedConfigPath = path.join(paths.root, "imported-config.toml");
  const rawConfig =
    profile.configurationSource === "cc-switch" &&
    (await exists(importedConfigPath))
      ? await readFile(importedConfigPath, "utf8")
      : generateProfileConfig(profile);
  const usesApiKey =
    profile.credentialKind === "api-key" ||
    (profile.provider !== "chatgpt" && !profile.credentialKind);
  const deepSeekCatalogPath =
    profile.provider === "deepseek"
      ? path.join(paths.codexHome, DEEPSEEK_MODEL_CATALOG_FILENAME)
      : undefined;
  if (deepSeekCatalogPath) {
    await writeFile(deepSeekCatalogPath, serializeDeepSeekModelCatalog(), {
      mode: 0o600,
    });
    await chmod(deepSeekCatalogPath, 0o600);
  }
  const config = normalizeRuntimeConfig(rawConfig, {
    model: profile.provider === "deepseek" ? profile.model : undefined,
    modelCatalogPath: deepSeekCatalogPath,
    reasoningEffort: profile.provider === "deepseek" ? "high" : undefined,
    removeReviewModel: profile.provider === "deepseek",
    desktopReasoningEfforts:
      profile.provider === "deepseek"
        ? DEEPSEEK_DESKTOP_REASONING_EFFORTS
        : undefined,
  });
  await writeFile(configPath, config, { mode: 0o600 });
  await chmod(configPath, 0o600);
  if (usesApiKey) {
    await importCurrentAuthIfMissing(baseCodexHome, paths.codexHome);
  }

  for (const sharedName of ["skills", "plugins"]) {
    const source = path.join(baseCodexHome, sharedName);
    const target = path.join(paths.codexHome, sharedName);
    if (!(await exists(source)) || (await exists(target))) continue;
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  }

  return paths;
}

export interface RuntimeConfigOverrides {
  model?: string;
  modelCatalogPath?: string;
  reasoningEffort?: string;
  removeReviewModel?: boolean;
  desktopReasoningEfforts?: string[];
}

export function normalizeRuntimeConfig(
  config: string,
  overrides: RuntimeConfigOverrides = {},
): string {
  let currentSection: string | undefined;
  let replacedModel = false;
  let replacedReasoningEffort = false;
  let foundDesktopSection = false;
  let wroteDesktopReasoningEfforts = false;
  const sectionPattern = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
  const desktopReasoningEffortsAssignment = overrides.desktopReasoningEfforts
    ? `enabled-reasoning-efforts = ${JSON.stringify(overrides.desktopReasoningEfforts)}`
    : undefined;
  const lines: string[] = [];

  for (const line of config.split(/\r?\n/)) {
    const sectionMatch = line.match(sectionPattern);
    if (sectionMatch) {
      if (
        currentSection === "desktop" &&
        desktopReasoningEffortsAssignment &&
        !wroteDesktopReasoningEfforts
      ) {
        lines.push(desktopReasoningEffortsAssignment);
        wroteDesktopReasoningEfforts = true;
      }
      currentSection = sectionMatch[1].trim().toLowerCase();
      if (currentSection === "desktop") foundDesktopSection = true;
    }
    if (
      /^\s*["']?(?:model_catalog_json|preferred_auth_method|forced_login_method)["']?\s*=/i.test(
        line,
      )
    ) {
      continue;
    }
    if (
      overrides.removeReviewModel &&
      !currentSection &&
      /^\s*["']?review_model["']?\s*=/i.test(line)
    ) {
      continue;
    }
    if (
      overrides.model &&
      !currentSection &&
      /^\s*["']?model["']?\s*=/i.test(line)
    ) {
      replacedModel = true;
      lines.push(`model = ${JSON.stringify(overrides.model)}`);
      continue;
    }
    if (
      overrides.reasoningEffort &&
      !currentSection &&
      /^\s*["']?model_reasoning_effort["']?\s*=/i.test(line)
    ) {
      replacedReasoningEffort = true;
      lines.push(
        `model_reasoning_effort = ${JSON.stringify(overrides.reasoningEffort)}`,
      );
      continue;
    }
    if (
      currentSection === "desktop" &&
      desktopReasoningEffortsAssignment &&
      /^\s*["']?enabled-reasoning-efforts["']?\s*=/i.test(line)
    ) {
      if (!wroteDesktopReasoningEfforts) {
        lines.push(desktopReasoningEffortsAssignment);
        wroteDesktopReasoningEfforts = true;
      }
      continue;
    }
    lines.push(line);
  }

  if (
    currentSection === "desktop" &&
    desktopReasoningEffortsAssignment &&
    !wroteDesktopReasoningEfforts
  ) {
    lines.push(desktopReasoningEffortsAssignment);
    wroteDesktopReasoningEfforts = true;
  }

  const managedAssignments: string[] = [];
  if (overrides.model && !replacedModel) {
    managedAssignments.push(`model = ${JSON.stringify(overrides.model)}`);
  }
  if (overrides.reasoningEffort && !replacedReasoningEffort) {
    managedAssignments.push(
      `model_reasoning_effort = ${JSON.stringify(overrides.reasoningEffort)}`,
    );
  }
  if (overrides.modelCatalogPath) {
    managedAssignments.push(
      `model_catalog_json = ${JSON.stringify(overrides.modelCatalogPath)}`,
    );
  }
  if (managedAssignments.length > 0) {
    const firstSection = lines.findIndex((line) => sectionPattern.test(line));
    lines.splice(
      firstSection === -1 ? lines.length : firstSection,
      0,
      ...managedAssignments,
      "",
    );
  }

  if (desktopReasoningEffortsAssignment && !foundDesktopSection) {
    lines.push("", "[desktop]", desktopReasoningEffortsAssignment);
  }

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

export async function importCurrentAuthIfMissing(
  baseCodexHome: string,
  destinationCodexHome: string,
): Promise<boolean> {
  const destination = path.join(destinationCodexHome, "auth.json");
  if (await exists(destination)) return false;
  const source = path.join(baseCodexHome, "auth.json");
  if (!(await exists(source))) return false;
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  return true;
}

export async function importCurrentAuth(
  baseCodexHome: string,
  destinationCodexHome: string,
): Promise<void> {
  const source = path.join(baseCodexHome, "auth.json");
  if (!(await exists(source))) {
    throw new Error("当前 Codex Home 中没有可导入的 auth.json；请直接启动后登录一次。");
  }
  const destination = path.join(destinationCodexHome, "auth.json");
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
}

export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
