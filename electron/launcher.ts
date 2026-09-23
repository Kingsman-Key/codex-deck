import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { LaunchResult, Profile } from "../src/shared/types";
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
): LaunchSpec {
  const env = sanitizeEnvironment(process.env);
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

    const spec = buildLaunchSpec(executable, paths, apiKey);
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
