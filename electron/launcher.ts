import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { LaunchResult, Profile } from "../src/shared/types";
import { getProfilePaths } from "./profile-runtime";
import type { ProfilePaths } from "./profile-runtime";

const execFileAsync = promisify(execFile);

export interface LaunchSpec {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function buildLaunchSpec(
  executable: string,
  paths: ProfilePaths,
  apiKey: string | null,
  runtimeMode: Profile["runtimeMode"] = "isolated",
): LaunchSpec {
  const env = sanitizeEnvironment(process.env);
  if (runtimeMode === "native") {
    return { executable, args: [], env };
  }
  env.CODEX_HOME = paths.codexHome;
  env.CODEX_SQLITE_HOME = paths.codexHome;
  if (apiKey) env.CODEX_DECK_API_KEY = apiKey;

  return {
    executable,
    args: [`--user-data-dir=${paths.browserData}`],
    env,
  };
}

export function sanitizeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set([
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_DECK_API_KEY",
    "OPENAI_API_KEY",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !blocked.has(key.toUpperCase())),
  );
}

export async function findDesktopExecutable(
  configuredPath?: string | null,
): Promise<string | null> {
  const candidates = [
    configuredPath,
    ...(process.platform === "darwin"
      ? [
          "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          "/Applications/Codex.app/Contents/MacOS/Codex",
          path.join(homedir(), "Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
          path.join(homedir(), "Applications/Codex.app/Contents/MacOS/Codex"),
        ]
      : process.platform === "win32"
        ? [
            process.env.LOCALAPPDATA
              ? path.join(
                  process.env.LOCALAPPDATA,
                  "Programs/OpenAI/Codex/Codex.exe",
                )
              : null,
            process.env.LOCALAPPDATA
              ? path.join(
                  process.env.LOCALAPPDATA,
                  "Programs/ChatGPT/ChatGPT.exe",
                )
              : null,
            process.env.ProgramFiles
              ? path.join(process.env.ProgramFiles, "OpenAI/Codex/Codex.exe")
              : null,
          ]
        : []),
  ].filter((value): value is string => Boolean(value));

  const { isExecutable } = await import("./profile-runtime");
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export class ProfileLauncher {
  private readonly processes = new Map<string, number>();

  constructor(private readonly onChanged: () => void) {}

  isRunning(id: string): boolean {
    const pid = this.processes.get(id);
    if (!pid) return false;
    if (isPidAlive(pid)) return true;
    this.processes.delete(id);
    return false;
  }

  async launch(
    profile: Profile,
    executable: string,
    paths: ProfilePaths,
    apiKey: string | null,
  ): Promise<LaunchResult> {
    const existingPid = this.processes.get(profile.id);
    if (existingPid && isPidAlive(existingPid)) {
      await focusProcess(existingPid);
      return { status: "focused", pid: existingPid };
    }

    if (profile.runtimeMode === "native") {
      const nativePid = await findDesktopProcessPid(executable);
      if (nativePid) {
        this.processes.set(profile.id, nativePid);
        await focusProcess(nativePid);
        this.onChanged();
        return { status: "focused", pid: nativePid };
      }
    }

    if (profile.runtimeMode !== "native" && paths.browserData) {
      const isolatedPid = await findIsolatedDesktopProcessPid(
        executable,
        paths.browserData,
      );
      if (isolatedPid) {
        this.processes.set(profile.id, isolatedPid);
        await focusProcess(isolatedPid);
        this.onChanged();
        return { status: "focused", pid: isolatedPid };
      }
    }

    const spec = buildLaunchSpec(
      executable,
      paths,
      apiKey,
      profile.runtimeMode ?? "isolated",
    );
    const child = spawn(spec.executable, spec.args, {
      cwd: homedir(),
      env: spec.env,
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Codex 桌面进程启动失败。");

    this.processes.set(profile.id, child.pid);
    child.once("exit", () => {
      if (this.processes.get(profile.id) === child.pid) {
        this.processes.delete(profile.id);
        this.onChanged();
      }
    });
    child.unref();
    this.onChanged();
    return { status: "launched", pid: child.pid };
  }

  async recoverProcesses(
    profiles: Profile[],
    executable: string,
    profilesDir: string,
  ): Promise<void> {
    if (process.platform !== "darwin") return;

    let processList: string;
    try {
      processList = await readDesktopProcessList();
    } catch {
      return;
    }

    for (const profile of profiles) {
      const pid =
        profile.runtimeMode === "native"
          ? parseNativeDesktopPid(processList, executable)
          : parseIsolatedDesktopPid(
              processList,
              executable,
              getProfilePaths(profilesDir, profile.id).browserData,
            );
      if (pid) this.processes.set(profile.id, pid);
    }
    this.onChanged();
  }

  async quit(id: string): Promise<void> {
    const pid = this.processes.get(id);
    if (!pid || !isPidAlive(pid)) {
      this.processes.delete(id);
      return;
    }
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T"]);
    } else {
      process.kill(pid, "SIGTERM");
    }
    this.processes.delete(id);
    this.onChanged();
  }
}

async function findDesktopProcessPid(executable: string): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  try {
    return parseNativeDesktopPid(await readDesktopProcessList(), executable);
  } catch {
    return null;
  }
}

async function findIsolatedDesktopProcessPid(
  executable: string,
  browserData: string,
): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  try {
    return parseIsolatedDesktopPid(
      await readDesktopProcessList(),
      executable,
      browserData,
    );
  } catch {
    return null;
  }
}

async function readDesktopProcessList(): Promise<string> {
  const { stdout } = await execFileAsync("ps", [
    "-axo",
    "pid=,command=",
    "-ww",
  ]);
  return stdout;
}

export function parseNativeDesktopPid(
  processList: string,
  executable: string,
): number | null {
  for (const line of processList.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    const isTarget =
      command === executable ||
      (command.startsWith(`${executable} `) &&
        !command.includes("--user-data-dir="));
    if (!isTarget) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

export function parseIsolatedDesktopPid(
  processList: string,
  executable: string,
  browserData: string,
): number | null {
  const marker = `--user-data-dir=${browserData}`;
  for (const line of processList.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    const args = command.startsWith(`${executable} `)
      ? command.slice(executable.length).trim().split(/\s+/)
      : [];
    if (!args.includes(marker)) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function focusProcess(pid: number): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("osascript", [
      "-e",
      `tell application \"System Events\" to set frontmost of first application process whose unix id is ${pid} to true`,
    ]);
    return;
  }

  if (process.platform === "win32") {
    const script = [
      "$sig='[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'",
      "$win=Add-Type -MemberDefinition $sig -Name Win32 -Namespace Native -PassThru",
      `$p=Get-Process -Id ${pid}`,
      "$null=$win::SetForegroundWindow($p.MainWindowHandle)",
    ].join(";");
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
  }
}
