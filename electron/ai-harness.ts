import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type {
  HarnessProfileStatus,
  HarnessStatus,
  Profile,
} from "../src/shared/types";
import { sanitizeEnvironment } from "./launcher";
import { exists, getProfilePaths, isExecutable } from "./profile-runtime";

const execFileAsync = promisify(execFile);

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_QUIET_MS = 45_000;
const DEFAULT_COOLDOWN_MS = 300_000;
const DEFAULT_PROBE_TIMEOUT_MS = 6_000;
const RESUME_TEXT = "继续";
const TAIL_SCAN_SIZES = [
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
  64 * 1024 * 1024,
];
const NON_RETRYABLE_SERVICE_PATTERN =
  /insufficient[_ -]?quota|quota exceeded|credits? exhausted|usage limit|billing|payment required|unauthorized|forbidden|invalid api key|account.{0,24}(?:suspended|deactivated)|额度(?:不足|用尽)|余额不足|认证失败|权限不足/i;
const NETWORK_ERROR_PATTERN =
  /error sending request|connection (?:failed|reset|closed|refused|aborted)|connect error|timed? out|timeout|fetch failed|socket|dns|econn|enet|etimedout|eai_again|stream.*(?:disconnect|closed|error)|compact.*(?:failed|error)|network (?:error|unavailable|failure)|网络(?:错误|中断|不可用)|连接(?:失败|重置|关闭|中断|超时)/i;
const CAPACITY_ERROR_PATTERN =
  /\bat capacity\b|capacity (?:has been )?(?:reached|exceeded)|\b(?:server|service|model|system|systems)\b.{0,40}\b(?:overloaded|over capacity|too busy|busy)\b|high demand|heavy load|服务繁忙|系统繁忙|容量已满|当前请求过多/i;
const RATE_LIMIT_ERROR_PATTERN =
  /\b429\b|too many requests|rate[_ -]?limit(?:ed|ing| exceeded)?|resource exhausted|请求过于频繁|限流|速率限制/i;
const TEMPORARY_SERVICE_ERROR_PATTERN =
  /temporar(?:ily|y) unavailable|service unavailable|bad gateway|gateway timeout|internal server error|upstream (?:error|unavailable)|\b(?:500|502|503|504)\b|please (?:try|retry) again later|try again shortly|something went wrong.{0,80}(?:try|retry) again|服务暂时不可用|稍后重试/i;

export type RetryableFailureKind =
  | "network"
  | "capacity"
  | "rate-limit"
  | "service";

interface ThreadRow {
  id: string;
  title: string;
  rollout_path: string;
}

export interface TurnEvent {
  type: "task_started" | "task_complete";
  timestamp?: string;
  error?: string;
}

export interface ResumeDecisionInput {
  event: TurnEvent;
  quietMs: number;
  requiredQuietMs: number;
  observedRunning: boolean;
  changedAfterEnabled: boolean;
  handled: boolean;
  cooldownRemainingMs: number;
}

interface PersistedHarnessState {
  version: 1;
  handled: Record<string, { fingerprint: string; resumedAt: number }>;
}

interface HarnessManagerOptions {
  dataRoot: string;
  profilesDir: string;
  baseCodexHome: string;
  getProfiles: () => Promise<Profile[]>;
  resolveDesktopExecutable: () => Promise<string | null>;
  resolveCodexCli?: () => Promise<string | null>;
  onChanged: () => void;
  pollMs?: number;
  quietMs?: number;
  cooldownMs?: number;
  now?: () => number;
  probe?: (url: string, timeoutMs: number) => Promise<boolean>;
  queue?: (input: {
    codexBin: string;
    codexHome: string;
    threadId: string;
    message: string;
  }) => Promise<void>;
}

export function isNetworkError(message: string): boolean {
  return NETWORK_ERROR_PATTERN.test(message);
}

export function classifyRetryableFailure(
  message: string,
): RetryableFailureKind | null {
  if (NON_RETRYABLE_SERVICE_PATTERN.test(message)) return null;
  if (NETWORK_ERROR_PATTERN.test(message)) return "network";
  if (CAPACITY_ERROR_PATTERN.test(message)) return "capacity";
  if (RATE_LIMIT_ERROR_PATTERN.test(message)) return "rate-limit";
  if (TEMPORARY_SERVICE_ERROR_PATTERN.test(message)) return "service";
  return null;
}

export function isRetryableFailure(message: string): boolean {
  return classifyRetryableFailure(message) !== null;
}

export function decideResume(input: ResumeDecisionInput): string | null {
  if (input.event.type !== "task_complete") return null;
  if (!input.event.error) return null;
  const failureKind = classifyRetryableFailure(input.event.error);
  if (!failureKind) return null;
  if (input.quietMs < input.requiredQuietMs) return null;
  if (!input.observedRunning && !input.changedAfterEnabled) return null;
  if (input.handled || input.cooldownRemainingMs > 0) return null;
  switch (failureKind) {
    case "capacity":
      return "上一轮因服务容量不足中断";
    case "rate-limit":
      return "上一轮因临时限流中断";
    case "service":
      return "上一轮因临时服务故障中断";
    default:
      return "上一轮因网络错误中断";
  }
}

export function parseLastTurnEvent(text: string): TurnEvent | null {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!/"type"\s*:\s*"(?:task_started|task_complete)"/.test(line)) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: unknown;
        payload?: {
          type?: unknown;
          error?: { message?: unknown } | string | null;
        };
      };
      const type = parsed.payload?.type;
      if (type !== "task_started" && type !== "task_complete") continue;
      const rawError = parsed.payload?.error;
      const error =
        typeof rawError === "string"
          ? rawError
          : rawError && typeof rawError.message === "string"
            ? rawError.message
            : undefined;
      return {
        type,
        timestamp:
          typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
        error,
      };
    } catch {
      // A tail window can begin in the middle of a JSONL row. Ignore it.
    }
  }
  return null;
}

export async function readLastTurnEvent(file: string): Promise<TurnEvent | null> {
  const fileStat = await stat(file);
  const handle = await open(file, "r");
  try {
    for (const requestedSize of TAIL_SCAN_SIZES) {
      const size = Math.min(fileStat.size, requestedSize);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, fileStat.size - size);
      const event = parseLastTurnEvent(buffer.toString("utf8"));
      if (event) return event;
      if (size === fileStat.size) break;
    }
    return null;
  } finally {
    await handle.close();
  }
}

export function probeUrlForProfile(profile: Profile): string {
  if (profile.baseUrl) {
    try {
      return new URL("/", profile.baseUrl).toString();
    } catch {
      // The profile validator normally prevents this; use the Codex endpoint as fallback.
    }
  }
  return "https://chatgpt.com/";
}

export async function findCodexCli(
  desktopExecutable: string | null,
): Promise<string | null> {
  const executableDir = desktopExecutable
    ? path.dirname(desktopExecutable)
    : undefined;
  const candidates = [
    ...(executableDir
      ? process.platform === "darwin"
        ? [
            path.resolve(
              executableDir,
              "../Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
            ),
            path.resolve(executableDir, "../Resources/codex-cli/bin/codex"),
          ]
        : process.platform === "win32"
          ? [
              path.resolve(executableDir, "resources/codex-cli/codex.exe"),
              path.resolve(executableDir, "resources/codex.exe"),
              path.resolve(executableDir, "../resources/codex-cli/codex.exe"),
              path.resolve(executableDir, "../Resources/codex-cli/codex.exe"),
            ]
          : []
      : []),
    process.env.CODEX_CLI_PATH,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function eventFingerprint(event: TurnEvent): string {
  return createHash("sha256")
    .update(JSON.stringify([event.type, event.timestamp ?? "", event.error ?? ""]))
    .digest("hex");
}

function profileHome(
  profile: Profile,
  profilesDir: string,
  baseCodexHome: string,
): string {
  return profile.runtimeMode === "native"
    ? baseCodexHome
    : getProfilePaths(profilesDir, profile.id).codexHome;
}

function listThreads(codexHome: string): ThreadRow[] {
  const databasePath = path.join(codexHome, "state_5.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 3000");
    return database
      .prepare(
        `SELECT id, title, rollout_path
         FROM threads
         WHERE archived = 0
         ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
         LIMIT 20`,
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        title: String(row.title ?? "未命名会话"),
        rollout_path: String(row.rollout_path),
      }));
  } finally {
    database.close();
  }
}

async function defaultProbe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { method: "HEAD", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultQueue(input: {
  codexBin: string;
  codexHome: string;
  threadId: string;
  message: string;
}): Promise<void> {
  await execFileAsync(
    input.codexBin,
    ["queue", "--thread", input.threadId, "--message", input.message],
    {
      env: {
        ...sanitizeEnvironment(process.env),
        CODEX_HOME: input.codexHome,
        CODEX_SQLITE_HOME: input.codexHome,
      },
      timeout: 15_000,
      windowsHide: true,
    },
  );
}

export class AiHarnessManager {
  private readonly stateFile: string;
  private readonly pollMs: number;
  private readonly quietMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly probe: (url: string, timeoutMs: number) => Promise<boolean>;
  private readonly queue: NonNullable<HarnessManagerOptions["queue"]>;
  private readonly activationTimes = new Map<string, number>();
  private readonly observedRunning = new Set<string>();
  private readonly eventCache = new Map<
    string,
    { mtimeMs: number; size: number; event: TurnEvent | null }
  >();
  private readonly statuses = new Map<string, HarnessProfileStatus>();
  private persisted: PersistedHarnessState = { version: 1, handled: {} };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private legacyAgentDetected = false;
  private checking: Promise<void> | null = null;
  private lastUpdatedAt: string | undefined;

  constructor(private readonly options: HarnessManagerOptions) {
    this.stateFile = path.join(options.dataRoot, "ai-harness-state.json");
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? defaultProbe;
    this.queue = options.queue ?? defaultQueue;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.persisted = await this.readState();
    this.legacyAgentDetected = await detectLegacyHarnessAgent();
    this.running = true;
    await this.runNow().catch((error) => {
      console.warn("AI Harness initial check failed:", cleanHarnessError(error));
    });
    this.timer = setInterval(() => {
      void this.runNow().catch((error) => {
        console.warn("AI Harness check failed:", cleanHarnessError(error));
      });
    }, this.pollMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runNow(profileId?: string): Promise<HarnessStatus> {
    if (!this.checking) {
      this.checking = this.runCycle(profileId).finally(() => {
        this.checking = null;
      });
    }
    await this.checking;
    return this.getStatus();
  }

  async getStatus(): Promise<HarnessStatus> {
    const profiles = await this.options.getProfiles();
    return {
      running: this.running,
      legacyAgentDetected: this.legacyAgentDetected,
      pollSeconds: Math.round(this.pollMs / 1000),
      quietSeconds: Math.round(this.quietMs / 1000),
      cooldownSeconds: Math.round(this.cooldownMs / 1000),
      updatedAt: this.lastUpdatedAt,
      profiles: profiles.map((profile) =>
        this.statuses.get(profile.id) ?? {
          profileId: profile.id,
          profileName: profile.name,
          enabled: Boolean(profile.harnessEnabled),
          state: profile.harnessEnabled ? "monitoring" : "disabled",
          network: "unknown",
          monitoredThreads: 0,
        },
      ),
    };
  }

  private async runCycle(profileId?: string): Promise<void> {
    const profiles = await this.options.getProfiles();
    const enabled = profiles.filter(
      (profile) =>
        profile.harnessEnabled && (!profileId || profile.id === profileId),
    );
    const enabledIds = new Set(
      profiles
        .filter((profile) => profile.harnessEnabled)
        .map((profile) => profile.id),
    );
    for (const profile of profiles) {
      if (!enabledIds.has(profile.id)) {
        this.activationTimes.delete(profile.id);
        for (const key of this.observedRunning) {
          if (key.startsWith(`${profile.id}:`)) this.observedRunning.delete(key);
        }
        this.statuses.set(profile.id, {
          profileId: profile.id,
          profileName: profile.name,
          enabled: false,
          state: "disabled",
          network: "unknown",
          monitoredThreads: 0,
        });
      }
    }

    let codexBin: string | null;
    try {
      const executable = await this.options.resolveDesktopExecutable();
      codexBin = this.options.resolveCodexCli
        ? await this.options.resolveCodexCli()
        : await findCodexCli(executable);
    } catch (error) {
      for (const profile of enabled) {
        this.statuses.set(profile.id, {
          profileId: profile.id,
          profileName: profile.name,
          enabled: true,
          state: "error",
          network: "unknown",
          monitoredThreads: 0,
          lastCheckAt: new Date(this.now()).toISOString(),
          lastError: cleanHarnessError(error),
        });
      }
      this.lastUpdatedAt = new Date(this.now()).toISOString();
      this.options.onChanged();
      return;
    }
    for (const profile of enabled) {
      if (!this.activationTimes.has(profile.id)) {
        this.activationTimes.set(profile.id, this.now());
      }
      await this.checkProfile(profile, codexBin);
    }
    this.lastUpdatedAt = new Date(this.now()).toISOString();
    this.options.onChanged();
  }

  private async checkProfile(
    profile: Profile,
    codexBin: string | null,
  ): Promise<void> {
    const codexHome = profileHome(
      profile,
      this.options.profilesDir,
      this.options.baseCodexHome,
    );
    const checkedAt = new Date(this.now()).toISOString();
    const baseStatus: HarnessProfileStatus = {
      profileId: profile.id,
      profileName: profile.name,
      enabled: true,
      state: "monitoring",
      network: "unknown",
      monitoredThreads: 0,
      lastCheckAt: checkedAt,
    };

    if (!codexBin) {
      this.statuses.set(profile.id, {
        ...baseStatus,
        state: "unsupported",
        lastError: "找不到桌面应用内置的 Codex CLI，无法投递续跑消息。",
      });
      return;
    }

    const databasePath = path.join(codexHome, "state_5.sqlite");
    if (!(await exists(databasePath))) {
      this.statuses.set(profile.id, baseStatus);
      return;
    }

    const previous = this.statuses.get(profile.id);
    try {
      const threads = listThreads(codexHome);
      let monitoredThreads = 0;
      let network: HarnessProfileStatus["network"] = "unknown";
      let state: HarnessProfileStatus["state"] = "monitoring";
      let lastResumeAt = previous?.lastResumeAt;
      let lastResumeThread = previous?.lastResumeThread;

      for (const thread of threads) {
        if (!(await exists(thread.rollout_path))) continue;
        const rolloutStat = await stat(thread.rollout_path);
        const key = `${profile.id}:${thread.id}`;
        const cached = this.eventCache.get(key);
        const event =
          cached?.mtimeMs === rolloutStat.mtimeMs &&
          cached.size === rolloutStat.size
            ? cached.event
            : await readLastTurnEvent(thread.rollout_path);
        if (
          cached?.mtimeMs !== rolloutStat.mtimeMs ||
          cached.size !== rolloutStat.size
        ) {
          this.eventCache.set(key, {
            mtimeMs: rolloutStat.mtimeMs,
            size: rolloutStat.size,
            event,
          });
        }
        if (!event) continue;
        if (event.type === "task_started") {
          this.observedRunning.add(key);
          monitoredThreads += 1;
          continue;
        }
        if (!event.error) {
          this.observedRunning.delete(key);
          continue;
        }
        if (!isRetryableFailure(event.error)) {
          this.observedRunning.delete(key);
          continue;
        }

        monitoredThreads += 1;
        const now = this.now();
        const fingerprint = eventFingerprint(event);
        const handled = this.persisted.handled[key];
        const activationTime = this.activationTimes.get(profile.id) ?? now;
        const decision = decideResume({
          event,
          quietMs: now - rolloutStat.mtimeMs,
          requiredQuietMs: this.quietMs,
          observedRunning: this.observedRunning.has(key),
          changedAfterEnabled: rolloutStat.mtimeMs >= activationTime,
          handled: handled?.fingerprint === fingerprint,
          cooldownRemainingMs: handled
            ? Math.max(0, this.cooldownMs - (now - handled.resumedAt))
            : 0,
        });
        if (!decision) continue;

        const online = await this.probe(
          probeUrlForProfile(profile),
          DEFAULT_PROBE_TIMEOUT_MS,
        );
        network = online ? "online" : "offline";
        if (!online) {
          state = "waiting-network";
          continue;
        }

        await this.queue({
          codexBin,
          codexHome,
          threadId: thread.id,
          message: RESUME_TEXT,
        });
        this.observedRunning.delete(key);
        this.persisted.handled[key] = { fingerprint, resumedAt: now };
        await this.writeState();
        lastResumeAt = new Date(now).toISOString();
        lastResumeThread = thread.title;
      }

      this.statuses.set(profile.id, {
        ...baseStatus,
        state,
        network,
        monitoredThreads,
        lastResumeAt,
        lastResumeThread,
      });
    } catch (error) {
      this.statuses.set(profile.id, {
        ...baseStatus,
        state: "error",
        lastResumeAt: previous?.lastResumeAt,
        lastResumeThread: previous?.lastResumeThread,
        lastError: cleanHarnessError(error),
      });
    }
  }

  private async readState(): Promise<PersistedHarnessState> {
    try {
      const value = JSON.parse(
        await readFile(this.stateFile, "utf8"),
      ) as PersistedHarnessState;
      if (
        value.version === 1 &&
        value.handled &&
        typeof value.handled === "object"
      ) {
        return value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not read AI Harness state:", cleanHarnessError(error));
      }
    }
    return { version: 1, handled: {} };
  }

  private async writeState(): Promise<void> {
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.persisted, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.stateFile);
  }
}

function cleanHarnessError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 400);
}

async function detectLegacyHarnessAgent(): Promise<boolean> {
  if (process.platform !== "darwin" || !process.getuid) return false;
  try {
    await execFileAsync("launchctl", [
      "print",
      `gui/${process.getuid()}/com.zhouhaibo.codex-keepalive`,
    ], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
