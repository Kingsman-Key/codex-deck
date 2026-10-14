import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AiHarnessManager,
  classifyRetryableFailure,
  decideResume,
  isNetworkError,
  isRetryableFailure,
  parseLastTurnEvent,
  probeUrlForProfile,
  readLastTurnEvent,
} from "../electron/ai-harness";
import type { Profile } from "../src/shared/types";
import { DatabaseSync } from "node:sqlite";

function eventLine(
  type: "task_started" | "task_complete",
  error?: string,
): string {
  return JSON.stringify({
    timestamp: "2026-10-13T10:00:00.000Z",
    payload: {
      type,
      ...(error ? { error: { message: error } } : {}),
    },
  });
}

describe("AI Harness", () => {
  it("recognizes network failures without treating ordinary task errors as reconnects", () => {
    expect(
      isNetworkError(
        "Error running remote compact task: Connection failed: error sending request",
      ),
    ).toBe(true);
    expect(isNetworkError("request timed out while reading stream")).toBe(true);
    expect(isNetworkError("TypeScript compilation failed on line 18")).toBe(false);
    expect(isNetworkError("permission denied")).toBe(false);
  });

  it("retries temporary capacity, rate-limit and service failures but not hard account limits", () => {
    expect(
      classifyRetryableFailure(
        "Codex is at capacity right now. Please try again later.",
      ),
    ).toBe("capacity");
    expect(
      classifyRetryableFailure("429 Too Many Requests: rate limit exceeded"),
    ).toBe("rate-limit");
    expect(
      classifyRetryableFailure("503 Service temporarily unavailable"),
    ).toBe("service");
    expect(isRetryableFailure("Something went wrong. Please try again.")).toBe(
      true,
    );
    expect(
      isRetryableFailure("You have reached your usage limit. Buy more credits."),
    ).toBe(false);
    expect(isRetryableFailure("401 Unauthorized: invalid API key")).toBe(false);
  });

  it("only resumes an observed or newly changed network failure after safeguards", () => {
    const base = {
      event: {
        type: "task_complete" as const,
        error: "Connection failed: error sending request",
      },
      quietMs: 60_000,
      requiredQuietMs: 45_000,
      observedRunning: true,
      changedAfterEnabled: false,
      handled: false,
      cooldownRemainingMs: 0,
    };

    expect(decideResume(base)).toBe("上一轮因网络错误中断");
    expect(
      decideResume({
        ...base,
        event: {
          type: "task_complete",
          error: "Codex is at capacity. Please try again later.",
        },
      }),
    ).toBe("上一轮因服务容量不足中断");
    expect(decideResume({ ...base, quietMs: 10_000 })).toBeNull();
    expect(decideResume({ ...base, observedRunning: false })).toBeNull();
    expect(
      decideResume({
        ...base,
        observedRunning: false,
        changedAfterEnabled: true,
      }),
    ).not.toBeNull();
    expect(decideResume({ ...base, handled: true })).toBeNull();
    expect(decideResume({ ...base, cooldownRemainingMs: 1000 })).toBeNull();
    expect(
      decideResume({
        ...base,
        event: { type: "task_complete", error: "test assertion failed" },
      }),
    ).toBeNull();
  });

  it("takes the newest task boundary from JSONL", () => {
    const parsed = parseLastTurnEvent(
      [
        eventLine("task_started"),
        JSON.stringify({ payload: { type: "assistant_message" } }),
        eventLine("task_complete", "request timed out"),
      ].join("\n"),
    );

    expect(parsed).toEqual({
      type: "task_complete",
      timestamp: "2026-10-13T10:00:00.000Z",
      error: "request timed out",
    });

    expect(
      parseLastTurnEvent(
        JSON.stringify({
          timestamp: "2026-10-13T10:01:00.000Z",
          payload: {
            type: "task_complete",
            error: "Codex is at capacity. Please try again later.",
          },
        }),
      ),
    ).toMatchObject({
      type: "task_complete",
      error: "Codex is at capacity. Please try again later.",
    });
  });

  it("expands the rollout tail window until it finds a boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-harness-"));
    const rollout = path.join(root, "rollout.jsonl");
    await writeFile(
      rollout,
      `${eventLine("task_started")}\n${"x".repeat(300_000)}\n`,
    );

    expect(await readLastTurnEvent(rollout)).toMatchObject({
      type: "task_started",
    });
  });

  it("probes the configured provider origin for API profiles", () => {
    const profile: Profile = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "DeepSeek",
      color: "#7CFFB2",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    expect(probeUrlForProfile(profile)).toBe("https://api.deepseek.com/");
    expect(
      probeUrlForProfile({ ...profile, provider: "chatgpt", baseUrl: undefined }),
    ).toBe("https://chatgpt.com/");
  });

  it("queues one resume after an observed task ends with a network error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-harness-"));
    const codexHome = root;
    const rollout = path.join(root, "rollout.jsonl");
    await writeFile(rollout, `${eventLine("task_started")}\n`);
    const database = new DatabaseSync(path.join(root, "state_5.sqlite"));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        rollout_path TEXT NOT NULL,
        archived INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER
      );
    `);
    database
      .prepare(
        "INSERT INTO threads (id, title, rollout_path, archived, updated_at, updated_at_ms) VALUES (?, ?, ?, 0, ?, ?)",
      )
      .run("thread-1", "Long task", rollout, 1, 1000);
    database.close();

    const profile: Profile = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Current",
      color: "#7CFFB2",
      provider: "chatgpt",
      runtimeMode: "native",
      harnessEnabled: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const queued: Array<{ threadId: string; message: string }> = [];
    const manager = new AiHarnessManager({
      dataRoot: root,
      profilesDir: path.join(root, "profiles"),
      baseCodexHome: codexHome,
      getProfiles: async () => [profile],
      resolveDesktopExecutable: async () => "/fake/Codex",
      resolveCodexCli: async () => "/fake/codex",
      onChanged: () => undefined,
      pollMs: 60 * 60 * 1000,
      probe: async () => true,
      queue: async ({ threadId, message }) => {
        queued.push({ threadId, message });
      },
    });

    await manager.start();
    await writeFile(
      rollout,
      `${eventLine("task_started")}\n${eventLine(
        "task_complete",
        "Connection failed: error sending request",
      )}\n`,
    );
    const quietTime = new Date(Date.now() - 60_000);
    await utimes(rollout, quietTime, quietTime);
    await manager.runNow();
    await manager.runNow();
    manager.stop();

    expect(queued).toEqual([{ threadId: "thread-1", message: "继续" }]);
    expect((await manager.getStatus()).profiles[0]).toMatchObject({
      state: "monitoring",
      lastResumeThread: "Long task",
    });
    const persisted = await readFile(
      path.join(root, "ai-harness-state.json"),
      "utf8",
    );
    expect(persisted).not.toContain("Connection failed");
    const fingerprints = Object.values(
      (
        JSON.parse(persisted) as {
          handled: Record<string, { fingerprint: string }>;
        }
      ).handled,
    ).map((entry) => entry.fingerprint);
    expect(fingerprints).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });
});
