import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLatestContext,
  exportProfileHistory,
  migrateProfileHistory,
  syncProfileHistoryFromMaster,
  transferProfileHistory,
} from "../electron/history-migration";
import type { Profile } from "../src/shared/types";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: PROFILE_ID,
    name: "DeepSeek",
    color: "#A8C7FA",
    provider: "custom",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    credentialKind: "api-key",
    configurationSource: "cc-switch",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

async function createSourceFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codex-deck-history-src-"));
  await writeFile(path.join(root, "config.toml"), 'model_provider = "custom"\n');
  const sessionPath = path.join(
    root,
    "sessions/2026/09/23/rollout-custom.jsonl",
  );
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(
    sessionPath,
    [
      '{"type":"session_meta","custom":true}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}',
      "",
    ].join("\n"),
  );

  const database = new DatabaseSync(path.join(root, "state_5.sqlite"));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO threads (id, rollout_path, model_provider, title, updated_at) VALUES
      ('custom-one', '${sessionPath}', 'custom', 'DeepSeek chat', 2),
      ('openai-one', '${path.join(root, "sessions/missing-openai.jsonl")}', 'openai', 'OpenAI chat', 1);
  `);
  database.close();

  const historyDatabase = new DatabaseSync(
    path.join(root, "thread_history_1.sqlite"),
  );
  historyDatabase.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL
    );
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL
    );
    CREATE TABLE thread_history_projection_state (
      thread_id TEXT PRIMARY KEY,
      next_rollout_byte_offset INTEGER NOT NULL
    );
    CREATE TABLE thread_realtime_items (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL
    );
    INSERT INTO thread_turns VALUES ('custom-one', 'turn-custom');
    INSERT INTO thread_turns VALUES ('openai-one', 'turn-openai');
    INSERT INTO thread_items VALUES ('custom-one', 'item-custom');
    INSERT INTO thread_items VALUES ('openai-one', 'item-openai');
    INSERT INTO thread_history_projection_state VALUES ('custom-one', 10);
    INSERT INTO thread_realtime_items VALUES ('custom-one', 'real-custom');
  `);
  historyDatabase.close();
  return root;
}

describe("history migration", () => {
  it("copies only the provider-matching session into the isolated profile", async () => {
    const base = await createSourceFixture();
    const profilesDir = path.join(
      await mkdtemp(path.join(tmpdir(), "codex-deck-history-target-")),
      "profiles",
    );
    const targetCodexHome = path.join(profilesDir, PROFILE_ID, "codex-home");
    await mkdir(targetCodexHome, { recursive: true });
    await writeFile(
      path.join(targetCodexHome, "config.toml"),
      'model_provider = "custom"\nmodel = "deepseek-v4-flash"\n',
    );

    const result = await migrateProfileHistory({
      profile: profile(),
      profilesDir,
      baseCodexHome: base,
    });

    expect(result.providerTag).toBe("custom");
    expect(result.matchedThreads).toBe(1);
    expect(result.copiedSessions).toBe(1);
    expect(result.missingSessions).toBe(0);

    const targetDatabase = new DatabaseSync(
      path.join(targetCodexHome, "state_5.sqlite"),
      { readOnly: true },
    );
    const rows = targetDatabase
      .prepare("SELECT id, rollout_path FROM threads ORDER BY id")
      .all() as Array<{ id: string; rollout_path: string }>;
    targetDatabase.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("custom-one");
    expect(rows[0].rollout_path).toBe(
      path.join(targetCodexHome, "sessions/2026/09/23/rollout-custom.jsonl"),
    );
    expect(
      await readFile(rows[0].rollout_path, "utf8"),
    ).toContain('"custom":true');

    const historyDatabase = new DatabaseSync(
      path.join(targetCodexHome, "thread_history_1.sqlite"),
      { readOnly: true },
    );
    const historyRows = historyDatabase
      .prepare("SELECT thread_id FROM thread_turns ORDER BY thread_id")
      .all() as Array<{ thread_id: string }>;
    historyDatabase.close();
    expect(historyRows).toEqual([{ thread_id: "custom-one" }]);
  });

  it("refuses to replace a profile that already has local threads", async () => {
    const base = await createSourceFixture();
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-history-busy-"));
    const profilesDir = path.join(root, "profiles");
    const targetCodexHome = path.join(profilesDir, PROFILE_ID, "codex-home");
    await mkdir(targetCodexHome, { recursive: true });
    await writeFile(
      path.join(targetCodexHome, "config.toml"),
      'model_provider = "custom"\n',
    );
    const targetDatabase = new DatabaseSync(
      path.join(targetCodexHome, "state_5.sqlite"),
    );
    targetDatabase.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO threads (id, rollout_path, model_provider, title, updated_at)
        VALUES ('existing', '/tmp/existing.jsonl', 'custom', 'Existing', 1);
    `);
    targetDatabase.close();

    await expect(
      migrateProfileHistory({
        profile: profile(),
        profilesDir,
        baseCodexHome: base,
      }),
    ).rejects.toThrow("已经有聊天记录");
  });

  it("transfers one provider history into another provider tag", async () => {
    const base = await createSourceFixture();
    const profilesDir = path.join(
      await mkdtemp(path.join(tmpdir(), "codex-deck-transfer-")),
      "profiles",
    );
    const targetProfileId = "22222222-2222-4222-8222-222222222222";
    const targetCodexHome = path.join(profilesDir, targetProfileId, "codex-home");
    await mkdir(targetCodexHome, { recursive: true });
    await writeFile(
      path.join(targetCodexHome, "config.toml"),
      'model_provider = "openai"\nmodel = "gpt-5.6-sol"\n',
    );

    const result = await transferProfileHistory({
      sourceProfile: profile({ runtimeMode: "native" }),
      targetProfile: profile({
        id: targetProfileId,
        name: "Official",
        provider: "chatgpt",
        baseUrl: undefined,
        model: "gpt-5.6-sol",
      }),
      profilesDir,
      baseCodexHome: base,
    });

    expect(result.sourceProviderTag).toBe("custom");
    expect(result.providerTag).toBe("openai");
    expect(result.copiedSessions).toBe(1);

    const targetDatabase = new DatabaseSync(
      path.join(targetCodexHome, "state_5.sqlite"),
      { readOnly: true },
    );
    const rows = targetDatabase
      .prepare("SELECT id, model_provider FROM threads ORDER BY id")
      .all() as Array<{ id: string; model_provider: string }>;
    targetDatabase.close();
    expect(rows).toEqual([{ id: "custom-one", model_provider: "openai" }]);
  });

  it("exports a readable copy without touching the source", async () => {
    const base = await createSourceFixture();
    const profilesDir = path.join(
      await mkdtemp(path.join(tmpdir(), "codex-deck-export-")),
      "profiles",
    );
    const exportRoot = await mkdtemp(
      path.join(tmpdir(), "codex-deck-export-root-"),
    );

    const result = await exportProfileHistory({
      profile: profile({ runtimeMode: "native" }),
      profilesDir,
      baseCodexHome: base,
      exportRoot,
    });

    expect(result.copiedSessions).toBe(1);
    expect(result.missingSessions).toBe(0);
    const manifest = JSON.parse(
      await readFile(
        path.join(result.directory, "history-manifest.json"),
        "utf8",
      ),
    ) as { providerTag: string };
    expect(manifest.providerTag).toBe("custom");
  });

  it("builds a short latest-context prompt for clipboard handoff", async () => {
    const base = await createSourceFixture();
    const context = await buildLatestContext({
      sourceCodexHome: base,
      providerTag: "custom",
    });

    expect(context).toContain("## 用户");
    expect(context).toContain("hello");
    expect(context).toContain("## 助手");
    expect(context).toContain("hi");
  });

  it("incrementally pulls new master history without deleting target threads", async () => {
    const base = await createSourceFixture();
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-sync-"));
    const profilesDir = path.join(root, "profiles");
    const targetCodexHome = path.join(profilesDir, PROFILE_ID, "codex-home");
    await mkdir(targetCodexHome, { recursive: true });
    await writeFile(
      path.join(targetCodexHome, "config.toml"),
      'model_provider = "custom"\n',
    );
    const targetDatabase = new DatabaseSync(
      path.join(targetCodexHome, "state_5.sqlite"),
    );
    targetDatabase.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO threads (id, rollout_path, model_provider, title, updated_at)
        VALUES ('existing', '/tmp/existing.jsonl', 'custom', 'Existing', 1);
    `);
    targetDatabase.close();

    const result = await syncProfileHistoryFromMaster({
      profile: profile(),
      profilesDir,
      baseCodexHome: base,
    });

    expect(result.matchedThreads).toBe(1);
    expect(result.targetThreads).toBe(2);
    const check = new DatabaseSync(
      path.join(targetCodexHome, "state_5.sqlite"),
      { readOnly: true },
    );
    const ids = check
      .prepare("SELECT id FROM threads ORDER BY id")
      .all() as Array<{ id: string }>;
    check.close();
    expect(ids).toEqual([{ id: "custom-one" }, { id: "existing" }]);
  });
});
