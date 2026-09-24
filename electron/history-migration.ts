import { DatabaseSync, backup } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  HistoryExportResult,
  HistoryMigrationResult,
  HistoryTransferResult,
  Profile,
} from "../src/shared/types";
import { exists, getProfilePaths } from "./profile-runtime";

interface ThreadRow {
  id: string;
  rollout_path: string;
}

interface ExportThreadRow extends ThreadRow {
  title: string;
}

interface TransferHistoryOptions {
  sourceCodexHome: string;
  targetCodexHome: string;
  sourceProviderTag: string;
  targetProviderTag: string;
}

interface TransferHistoryInternalResult {
  copied: number;
  missing: number;
  targetThreads: number;
  matchedThreads: number;
}

export async function migrateProfileHistory(options: {
  profile: Profile;
  profilesDir: string;
  baseCodexHome: string;
}): Promise<HistoryMigrationResult> {
  const { profile, profilesDir, baseCodexHome } = options;
  if (profile.runtimeMode === "native") {
    throw new Error("“当前 Codex”已经使用原历史目录，不需要迁移。");
  }

  const paths = getProfilePaths(profilesDir, profile.id);
  const sourceDatabasePath = path.join(baseCodexHome, "state_5.sqlite");
  const targetDatabasePath = path.join(paths.codexHome, "state_5.sqlite");
  if (!(await exists(sourceDatabasePath))) {
    throw new Error("当前 Codex Home 中没有可迁移的会话索引。");
  }

  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await ensureTargetIsEmpty(targetDatabasePath);

  const providerTag = await resolveProviderTag(
    path.join(paths.codexHome, "config.toml"),
    profile,
  );
  const result = await transferHistoryBetweenHomes({
    sourceCodexHome: baseCodexHome,
    targetCodexHome: paths.codexHome,
    sourceProviderTag: providerTag,
    targetProviderTag: providerTag,
  });
  return {
    providerTag,
    matchedThreads: result.matchedThreads,
    copiedSessions: result.copied,
    missingSessions: result.missing,
    targetThreads: result.targetThreads,
  };
}

export async function syncProfileHistoryFromMaster(options: {
  profile: Profile;
  profilesDir: string;
  baseCodexHome: string;
}): Promise<HistoryMigrationResult> {
  const { profile, profilesDir, baseCodexHome } = options;
  if (profile.runtimeMode === "native") {
    throw new Error("“当前 Codex”已经是主库，不需要同步。");
  }

  const paths = getProfilePaths(profilesDir, profile.id);
  const sourceDatabasePath = path.join(baseCodexHome, "state_5.sqlite");
  const targetDatabasePath = path.join(paths.codexHome, "state_5.sqlite");
  if (!(await exists(sourceDatabasePath))) {
    throw new Error("主库中没有可同步的会话索引。");
  }
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });

  const providerTag = await resolveProviderTag(
    path.join(paths.codexHome, "config.toml"),
    profile,
  );
  const targetThreads = await countThreads(targetDatabasePath);
  if (targetThreads === 0) {
    return migrateProfileHistory(options);
  }

  const targetIds = await readThreadIds(targetDatabasePath);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-deck-sync-"));
  const snapshotPath = path.join(tempRoot, "state.sqlite");
  let copyResult = {
    copied: 0,
    missing: 0,
    migratedRows: [] as ThreadRow[],
  };

  try {
    await createDatabaseSnapshot(sourceDatabasePath, snapshotPath);
    const sourceDatabase = new DatabaseSync(snapshotPath, { readOnly: true });
    let sourceRows: ThreadRow[] = [];
    try {
      sourceRows = (
        sourceDatabase
          .prepare(
            "SELECT id, rollout_path FROM threads WHERE model_provider = ?",
          )
          .all(providerTag) as unknown as ThreadRow[]
      ).filter((row) => !targetIds.has(row.id));
    } finally {
      sourceDatabase.close();
    }

    copyResult = await copySessionFiles(
      baseCodexHome,
      paths.codexHome,
      sourceRows,
    );
    const newIds = new Set(copyResult.migratedRows.map((row) => row.id));
    if (newIds.size > 0) {
      await mergeStateRows(
        snapshotPath,
        targetDatabasePath,
        copyResult.migratedRows,
        providerTag,
        baseCodexHome,
        paths.codexHome,
      );
      await mergeThreadHistoryRows(baseCodexHome, paths.codexHome, newIds);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    providerTag,
    matchedThreads: copyResult.migratedRows.length,
    copiedSessions: copyResult.copied,
    missingSessions: copyResult.missing,
    targetThreads: await countThreads(targetDatabasePath),
  };
}

export async function transferProfileHistory(options: {
  sourceProfile: Profile;
  targetProfile: Profile;
  profilesDir: string;
  baseCodexHome: string;
}): Promise<HistoryTransferResult> {
  const { sourceProfile, targetProfile, profilesDir, baseCodexHome } = options;
  if (targetProfile.runtimeMode === "native") {
    throw new Error("“当前 Codex”不能作为历史接收目标。");
  }
  const sourceHome = resolveProfileCodexHome(
    sourceProfile,
    profilesDir,
    baseCodexHome,
  );
  const targetHome = resolveProfileCodexHome(
    targetProfile,
    profilesDir,
    baseCodexHome,
  );
  if (sourceHome === targetHome) {
    throw new Error("来源和目标是同一个 Codex Home。");
  }

  const sourceProviderTag = await resolveProviderTag(
    path.join(sourceHome, "config.toml"),
    sourceProfile,
  );
  const targetProviderTag = await resolveProviderTag(
    path.join(targetHome, "config.toml"),
    targetProfile,
  );
  const result = await transferHistoryBetweenHomes({
    sourceCodexHome: sourceHome,
    targetCodexHome: targetHome,
    sourceProviderTag,
    targetProviderTag,
  });
  return {
    providerTag: targetProviderTag,
    sourceProviderTag,
    matchedThreads: result.matchedThreads,
    copiedSessions: result.copied,
    missingSessions: result.missing,
    targetThreads: result.targetThreads,
  };
}

export async function exportProfileHistory(options: {
  profile: Profile;
  profilesDir: string;
  baseCodexHome: string;
  exportRoot?: string;
}): Promise<HistoryExportResult> {
  const { profile, profilesDir, baseCodexHome, exportRoot } = options;
  const sourceHome = resolveProfileCodexHome(profile, profilesDir, baseCodexHome);
  const providerTag = await resolveProviderTag(
    path.join(sourceHome, "config.toml"),
    profile,
  );
  return exportReadableHistory({
    sourceCodexHome: sourceHome,
    providerTag,
    profileName: profile.name,
    exportRoot,
  });
}

export async function buildLatestContext(options: {
  sourceCodexHome: string;
  providerTag: string;
}): Promise<string> {
  const sourceDatabasePath = path.join(options.sourceCodexHome, "state_5.sqlite");
  if (!(await exists(sourceDatabasePath))) {
    throw new Error("来源 Codex Home 中没有可读取的会话索引。");
  }

  const database = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  const row = database
    .prepare(
      "SELECT rollout_path FROM threads WHERE model_provider = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(options.providerTag) as { rollout_path?: string } | undefined;
  database.close();
  if (!row?.rollout_path || !(await exists(row.rollout_path))) {
    throw new Error("来源 provider 还没有可复制的会话。");
  }

  const messages = await readLatestMessages(row.rollout_path);
  if (!messages.length) {
    throw new Error("这个会话没有可复制的用户或助手消息。");
  }
  return [
    "请继续处理下面的上下文，不要重复提问；如果信息不足，直接基于现有上下文回答。",
    "",
    ...messages,
  ].join("\n");
}

async function exportReadableHistory(options: {
  sourceCodexHome: string;
  providerTag: string;
  profileName: string;
  exportRoot?: string;
}): Promise<HistoryExportResult> {
  const sourceDatabasePath = path.join(options.sourceCodexHome, "state_5.sqlite");
  if (!(await exists(sourceDatabasePath))) {
    throw new Error("来源 Codex Home 中没有可导出的会话索引。");
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const directory = path.join(
    options.exportRoot ?? path.join(homedir(), "Downloads", "Codex Deck History"),
    `${sanitizeFileName(options.profileName)}-${stamp}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const database = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  const rows = database
    .prepare(
      "SELECT id, rollout_path, title FROM threads WHERE model_provider = ?",
    )
    .all(options.providerTag) as unknown as ExportThreadRow[];
  database.close();

  let copiedSessions = 0;
  let missingSessions = 0;
  for (const row of rows) {
    const sourceRolloutPath = row.rollout_path;
    if (!(await exists(sourceRolloutPath))) {
      missingSessions += 1;
      continue;
    }

    const relativePath = path.relative(options.sourceCodexHome, sourceRolloutPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      missingSessions += 1;
      continue;
    }

    const rawTarget = path.join(directory, "sessions", relativePath);
    await mkdir(path.dirname(rawTarget), { recursive: true, mode: 0o700 });
    await copyFile(sourceRolloutPath, rawTarget);

    const markdown = await buildReadableMarkdown(sourceRolloutPath);
    const markdownName = `${sanitizeFileName(row.title || row.id).slice(0, 80)}-${row.id.slice(0, 8)}.md`;
    await writeFile(path.join(directory, "conversations", markdownName), markdown, {
      mode: 0o600,
    }).catch(async (error) => {
      await mkdir(path.join(directory, "conversations"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(path.join(directory, "conversations", markdownName), markdown, {
        mode: 0o600,
      });
      void error;
    });
    copiedSessions += 1;
  }

  await writeFile(
    path.join(directory, "history-manifest.json"),
    `${JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        profileName: options.profileName,
        providerTag: options.providerTag,
        threadCount: rows.length,
        copiedSessions,
        missingSessions,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  return {
    directory,
    threadCount: rows.length,
    copiedSessions,
    missingSessions,
  };
}

async function readLatestMessages(sourcePath: string): Promise<string[]> {
  const lines = (await readFile(sourcePath, "utf8")).split(/\r?\n/);
  const messages: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "response_item") continue;
    const payload = isPlainObject(event.payload) ? event.payload : null;
    if (!payload || payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractMessageText(payload.content);
    if (!text) continue;
    messages.push(
      `${role === "user" ? "## 用户\n" : "## 助手\n"}${text.slice(0, 6000)}`,
    );
    if (messages.length >= 16) break;
  }
  return messages;
}

async function buildReadableMarkdown(sourcePath: string): Promise<string> {
  const lines = (await readFile(sourcePath, "utf8")).split(/\r?\n/);
  const sections: string[] = [`# Codex Conversation\n`, `> 导出时间：${new Date().toLocaleString("zh-CN")}\n`];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "response_item") continue;
    const payload = isPlainObject(event.payload) ? event.payload : null;
    if (!payload || payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractMessageText(payload.content);
    if (!text) continue;
    sections.push(role === "user" ? "## 用户\n" : "## 助手\n");
    sections.push(`${text}\n`);
  }
  return sections.join("\n").trim() + "\n";
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isPlainObject(item)) return "";
      if (typeof item.text === "string") return item.text;
      if (
        item.type === "input_image" ||
        item.type === "local_image" ||
        item.type === "image_url"
      ) {
        return "[图片]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeFileName(value: string): string {
  return (
    value
      .replace(/[^0-9A-Za-z\u4e00-\u9fff._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "conversation"
  );
}

async function transferHistoryBetweenHomes(
  options: TransferHistoryOptions,
): Promise<TransferHistoryInternalResult> {
  const {
    sourceCodexHome,
    targetCodexHome,
    sourceProviderTag,
    targetProviderTag,
  } = options;
  const sourceDatabasePath = path.join(sourceCodexHome, "state_5.sqlite");
  const targetDatabasePath = path.join(targetCodexHome, "state_5.sqlite");
  if (!(await exists(sourceDatabasePath))) {
    throw new Error("来源 Codex Home 中没有可迁移的会话索引。");
  }

  await mkdir(targetCodexHome, { recursive: true, mode: 0o700 });
  await ensureTargetIsEmpty(targetDatabasePath);

  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-deck-history-"));
  const snapshotPath = path.join(tempRoot, "state.sqlite");
  let copied: { copied: number; missing: number } = { copied: 0, missing: 0 };

  try {
    await createDatabaseSnapshot(sourceDatabasePath, snapshotPath);
    const database = new DatabaseSync(snapshotPath);
    try {
      const rows = database
        .prepare(
          "SELECT id, rollout_path FROM threads WHERE model_provider = ?",
        )
        .all(sourceProviderTag) as unknown as ThreadRow[];
      const keptIds = new Set(rows.map((row) => row.id));
      await migrateThreadHistory(sourceCodexHome, targetCodexHome, keptIds);
      copied = await copySessionFiles(
        sourceCodexHome,
        targetCodexHome,
        rows,
      );

      const updatePath = database.prepare(
        "UPDATE threads SET rollout_path = ?, model_provider = ? WHERE id = ?",
      );
      for (const row of rows) {
        updatePath.run(
          rewriteRolloutPath(sourceCodexHome, targetCodexHome, row.rollout_path),
          targetProviderTag,
          row.id,
        );
      }

      removeNonMatchingRows(database, keptIds, sourceProviderTag);
    } finally {
      database.close();
    }

    await removeDatabaseSidecars(targetDatabasePath);
    await copyFile(snapshotPath, targetDatabasePath);
    await chmod(targetDatabasePath, 0o600);
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  const targetDatabase = new DatabaseSync(targetDatabasePath, { readOnly: true });
  let targetThreads = 0;
  try {
    const result = targetDatabase
      .prepare("SELECT COUNT(*) AS count FROM threads")
      .get() as { count?: number } | undefined;
    targetThreads = Number(result?.count ?? 0);
  } finally {
    targetDatabase.close();
  }

  const matched = await countMatchingThreads(targetDatabasePath, targetProviderTag);
  return {
    matchedThreads: matched,
    copied: copied.copied,
    missing: copied.missing,
    targetThreads,
  };
}

function resolveProfileCodexHome(
  profile: Profile,
  profilesDir: string,
  baseCodexHome: string,
): string {
  if (profile.runtimeMode === "native") return baseCodexHome;
  return getProfilePaths(profilesDir, profile.id).codexHome;
}

async function countThreads(databasePath: string): Promise<number> {
  if (!(await exists(databasePath))) return 0;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!tableExists(database, "threads")) return 0;
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM threads")
      .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } finally {
    database.close();
  }
}

async function readThreadIds(databasePath: string): Promise<Set<string>> {
  if (!(await exists(databasePath))) return new Set();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT id FROM threads")
      .all() as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  } finally {
    database.close();
  }
}

async function mergeStateRows(
  sourceSnapshotPath: string,
  targetDatabasePath: string,
  rows: ThreadRow[],
  providerTag: string,
  sourceCodexHome: string,
  targetCodexHome: string,
): Promise<void> {
  const database = new DatabaseSync(targetDatabasePath);
  const newIds = new Set(rows.map((row) => row.id));
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("ATTACH DATABASE ? AS source_sync").run(sourceSnapshotPath);
    const columns = tableColumns(database, "threads");
    const selectSource = database.prepare(
      `SELECT ${columns.join(", ")} FROM source_sync.threads WHERE id = ?`,
    );
    const insertTarget = database.prepare(
      `INSERT OR IGNORE INTO threads (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    );

    database.exec("BEGIN IMMEDIATE");
    for (const row of rows) {
      const source = selectSource.get(row.id) as
        | Record<string, unknown>
        | undefined;
      if (!source) continue;
      const values = columns.map((column): SQLInputValue => {
        if (column === "rollout_path") {
          return rewriteRolloutPath(
            sourceCodexHome,
            targetCodexHome,
            row.rollout_path,
          );
        }
        if (column === "model_provider") return providerTag;
        return (source[column] ?? null) as SQLInputValue;
      });
      insertTarget.run(...values);
    }
    copyRowsByIds(database, "thread_attachments", "thread_id", newIds);
    copyRowsByIds(database, "thread_dynamic_tools", "thread_id", newIds);
    copyNewSpawnEdges(database, newIds);
    database.exec("COMMIT");
    database.exec("DETACH DATABASE source_sync");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors when the transaction never started.
    }
    throw error;
  } finally {
    database.close();
  }
}

function tableColumns(database: DatabaseSync, table: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function copyRowsByIds(
  database: DatabaseSync,
  table: string,
  idColumn: string,
  ids: Set<string>,
): void {
  if (!tableExists(database, table) || !tableExistsAttached(database, table)) {
    return;
  }
  const placeholders = Array.from(ids, () => "?").join(", ");
  if (!placeholders) return;
  database
    .prepare(
      `INSERT OR IGNORE INTO ${table}
       SELECT * FROM source_sync.${table}
       WHERE ${idColumn} IN (${placeholders})`,
    )
    .run(...Array.from(ids));
}

function copyNewSpawnEdges(database: DatabaseSync, ids: Set<string>): void {
  if (
    !tableExists(database, "thread_spawn_edges") ||
    !tableExistsAttached(database, "thread_spawn_edges")
  ) {
    return;
  }
  const placeholders = Array.from(ids, () => "?").join(", ");
  if (!placeholders) return;
  database
    .prepare(
      `INSERT OR IGNORE INTO thread_spawn_edges
       SELECT * FROM source_sync.thread_spawn_edges
       WHERE parent_thread_id IN (${placeholders})
         AND child_thread_id IN (${placeholders})`,
    )
    .run(...Array.from(ids), ...Array.from(ids));
}

async function mergeThreadHistoryRows(
  sourceCodexHome: string,
  targetCodexHome: string,
  ids: Set<string>,
): Promise<void> {
  const sourceName = await findThreadHistoryDatabase(sourceCodexHome);
  if (!sourceName || ids.size === 0) return;
  const sourcePath = path.join(sourceCodexHome, sourceName);
  const targetPath = path.join(targetCodexHome, sourceName);

  if (!(await exists(targetPath))) {
    await migrateThreadHistory(sourceCodexHome, targetCodexHome, ids);
    return;
  }

  const database = new DatabaseSync(targetPath);
  try {
    if (!tableExists(database, "thread_turns")) {
      const schema = await readThreadHistorySchema(sourcePath);
      for (const statement of schema) database.exec(toIfNotExists(statement));
    }
    database.prepare("ATTACH DATABASE ? AS source_history").run(sourcePath);
    const placeholders = Array.from(ids, () => "?").join(", ");
    database.exec("BEGIN IMMEDIATE");
    for (const table of [
      "thread_turns",
      "thread_items",
      "thread_history_projection_state",
      "thread_realtime_items",
    ]) {
      if (
        !tableExists(database, table) ||
        !tableExistsAttached(database, table)
      ) {
        continue;
      }
      database
        .prepare(
          `INSERT OR IGNORE INTO ${table}
           SELECT * FROM source_history.${table}
           WHERE thread_id IN (${placeholders})`,
        )
        .run(...Array.from(ids));
    }
    database.exec("COMMIT");
    database.exec("DETACH DATABASE source_history");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors when the transaction never started.
    }
    throw error;
  } finally {
    database.close();
  }
}

async function migrateThreadHistory(
  baseCodexHome: string,
  targetCodexHome: string,
  keptIds: Set<string>,
): Promise<void> {
  const sourceName = await findThreadHistoryDatabase(baseCodexHome);
  if (!sourceName) return;

  const sourcePath = path.join(baseCodexHome, sourceName);
  const targetPath = path.join(targetCodexHome, sourceName);
  await ensureThreadHistoryIsEmpty(targetPath);
  await rm(targetPath, { force: true }).catch(() => undefined);
  await removeDatabaseSidecars(targetPath);

  const schema = await readThreadHistorySchema(sourcePath);
  const targetDatabase = new DatabaseSync(targetPath);
  try {
    targetDatabase.exec("PRAGMA foreign_keys = OFF");
    for (const statement of schema) {
      targetDatabase.exec(toIfNotExists(statement));
    }
    targetDatabase
      .prepare("ATTACH DATABASE ? AS source_history")
      .run(sourcePath);
    if (
      tableExists(targetDatabase, "_sqlx_migrations") &&
      tableExistsAttached(targetDatabase, "_sqlx_migrations")
    ) {
      targetDatabase
        .prepare(
          "INSERT OR IGNORE INTO _sqlx_migrations SELECT * FROM source_history._sqlx_migrations",
        )
        .run();
    }
    copyThreadHistoryRows(targetDatabase, "thread_turns", "thread_id", keptIds);
    copyThreadHistoryRows(targetDatabase, "thread_items", "thread_id", keptIds);
    copyThreadHistoryRows(
      targetDatabase,
      "thread_history_projection_state",
      "thread_id",
      keptIds,
    );
    copyThreadHistoryRows(
      targetDatabase,
      "thread_realtime_items",
      "thread_id",
      keptIds,
    );
    targetDatabase.exec("DETACH DATABASE source_history");
  } finally {
    targetDatabase.close();
  }
}

async function findThreadHistoryDatabase(
  codexHome: string,
): Promise<string | null> {
  const entries = await readdir(codexHome).catch(() => []);
  return (
    entries
      .filter((entry) => /^thread_history_\d+\.sqlite$/.test(entry))
      .sort((left, right) => left.localeCompare(right))[0] ?? null
  );
}

async function ensureThreadHistoryIsEmpty(databasePath: string): Promise<void> {
  if (!(await exists(databasePath))) return;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!tableExists(database, "thread_turns")) return;
    const result = database
      .prepare("SELECT COUNT(*) AS count FROM thread_turns")
      .get() as { count?: number } | undefined;
    if (Number(result?.count ?? 0) > 0) {
      throw new Error(
        "这个配置已经有聊天记录。为避免合并重复或覆盖，请先在 Codex 中导出/处理这些记录，或新建一个空白配置后再迁移。",
      );
    }
  } finally {
    database.close();
  }
}

async function readThreadHistorySchema(sourcePath: string): Promise<string[]> {
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT type, name, sql
         FROM sqlite_master
         WHERE sql IS NOT NULL
         ORDER BY
           CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 ELSE 3 END,
           name`,
      )
      .all() as Array<{ sql: string }>;
    return rows.map((row) => row.sql);
  } finally {
    database.close();
  }
}

function copyThreadHistoryRows(
  targetDatabase: DatabaseSync,
  table: string,
  idColumn: string,
  keptIds: Set<string>,
): void {
  if (!tableExists(targetDatabase, table)) return;
  if (!tableExistsAttached(targetDatabase, table)) return;
  const placeholders = Array.from(keptIds, () => "?").join(", ");
  if (!placeholders) return;
  targetDatabase
    .prepare(
      `INSERT OR IGNORE INTO main.${table}
       SELECT * FROM source_history.${table}
       WHERE ${idColumn} IN (${placeholders})`,
    )
    .run(...Array.from(keptIds));
}

function tableExistsAttached(
  database: DatabaseSync,
  table: string,
): boolean {
  const row = database
    .prepare(
      "SELECT 1 AS present FROM source_history.sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table) as { present?: number } | undefined;
  return Boolean(row?.present);
}

async function ensureTargetIsEmpty(databasePath: string): Promise<void> {
  if (!(await exists(databasePath))) return;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = database
      .prepare("SELECT COUNT(*) AS count FROM threads")
      .get() as { count?: number } | undefined;
    if (Number(result?.count ?? 0) > 0) {
      throw new Error(
        "这个配置已经有聊天记录。为避免合并重复或覆盖，请先在 Codex 中导出/处理这些记录，或新建一个空白配置后再迁移。",
      );
    }
  } finally {
    database.close();
  }
}

export async function resolveProviderTag(
  configPath: string,
  profile: Profile,
): Promise<string> {
  if (!(await exists(configPath))) {
    return profile.provider === "chatgpt" ? "openai" : "deck_provider";
  }
  const content = await readFile(configPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#") || line.startsWith("[")) continue;
    const match = line.match(/^model_provider\s*=\s*(.+)$/);
    if (!match) continue;
    return (
      parseTomlString(match[1]) ??
      (profile.provider === "chatgpt" ? "openai" : "deck_provider")
    );
  }
  return profile.provider === "chatgpt" ? "openai" : "deck_provider";
}

async function createDatabaseSnapshot(
  sourcePath: string,
  snapshotPath: string,
): Promise<void> {
  const sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(sourceDatabase, snapshotPath);
  } finally {
    sourceDatabase.close();
  }
}

async function copySessionFiles(
  baseCodexHome: string,
  targetCodexHome: string,
  rows: ThreadRow[],
): Promise<{ copied: number; missing: number; migratedRows: ThreadRow[] }> {
  let copied = 0;
  let missing = 0;
  const migratedRows: ThreadRow[] = [];
  for (const row of rows) {
    const sourceRolloutPath = row.rollout_path;
    if (
      !sourceRolloutPath.startsWith(baseCodexHome + path.sep) &&
      sourceRolloutPath !== baseCodexHome
    ) {
      missing += 1;
      continue;
    }
    if (!(await exists(sourceRolloutPath))) {
      missing += 1;
      continue;
    }
    const relativePath = path.relative(baseCodexHome, sourceRolloutPath);
    const targetRolloutPath = path.join(targetCodexHome, relativePath);
    await mkdir(path.dirname(targetRolloutPath), { recursive: true, mode: 0o700 });
    await copyFile(sourceRolloutPath, targetRolloutPath);
    await chmod(targetRolloutPath, 0o600);
    copied += 1;
    migratedRows.push(row);
  }
  return { copied, missing, migratedRows };
}

function rewriteRolloutPath(
  baseCodexHome: string,
  targetCodexHome: string,
  rolloutPath: string,
): string {
  const relativePath = path.relative(baseCodexHome, rolloutPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return rolloutPath;
  }
  return path.join(targetCodexHome, relativePath);
}

function removeNonMatchingRows(
  database: DatabaseSync,
  keptIds: Set<string>,
  providerTag: string,
): void {
  deleteRowsNotIn(database, "thread_attachments", "thread_id", keptIds);
  deleteRowsNotIn(database, "thread_dynamic_tools", "thread_id", keptIds);
  deleteSpawnEdgesNotIn(database, keptIds);

  const placeholders = Array.from(keptIds, () => "?").join(", ");
  if (placeholders) {
    database
      .prepare(
        `DELETE FROM threads WHERE model_provider <> ? AND id NOT IN (${placeholders})`,
      )
      .run(providerTag, ...Array.from(keptIds));
  } else {
    database.prepare("DELETE FROM threads WHERE model_provider <> ?").run(providerTag);
  }
}

function deleteRowsNotIn(
  database: DatabaseSync,
  table: string,
  idColumn: string,
  keptIds: Set<string>,
): void {
  if (!tableExists(database, table)) return;
  const placeholders = Array.from(keptIds, () => "?").join(", ");
  if (placeholders) {
    database
      .prepare(`DELETE FROM ${table} WHERE ${idColumn} NOT IN (${placeholders})`)
      .run(...Array.from(keptIds));
  } else {
    database.prepare(`DELETE FROM ${table}`).run();
  }
}

function deleteSpawnEdgesNotIn(
  database: DatabaseSync,
  keptIds: Set<string>,
): void {
  if (!tableExists(database, "thread_spawn_edges")) return;
  const placeholders = Array.from(keptIds, () => "?").join(", ");
  if (placeholders) {
    database
      .prepare(
        `DELETE FROM thread_spawn_edges
         WHERE parent_thread_id NOT IN (${placeholders})
            OR child_thread_id NOT IN (${placeholders})`,
      )
      .run(...Array.from(keptIds), ...Array.from(keptIds));
  } else {
    database.prepare("DELETE FROM thread_spawn_edges").run();
  }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table) as { present?: number } | undefined;
  return Boolean(row?.present);
}

async function removeDatabaseSidecars(databasePath: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await rm(`${databasePath}${suffix}`, { force: true }).catch(() => undefined);
  }
}

function toIfNotExists(sql: string): string {
  return sql
    .replace(/^CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS")
    .replace(/^CREATE UNIQUE INDEX/i, "CREATE UNIQUE INDEX IF NOT EXISTS")
    .replace(/^CREATE INDEX/i, "CREATE INDEX IF NOT EXISTS")
    .replace(/^CREATE TRIGGER/i, "CREATE TRIGGER IF NOT EXISTS");
}

async function countMatchingThreads(
  databasePath: string,
  providerTag: string,
): Promise<number> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = database
      .prepare("SELECT COUNT(*) AS count FROM threads WHERE model_provider = ?")
      .get(providerTag) as { count?: number } | undefined;
    return Number(result?.count ?? 0);
  } finally {
    database.close();
  }
}

function parseTomlString(value: string): string | undefined {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    if (withoutComment.startsWith('"')) {
      try {
        return JSON.parse(withoutComment) as string;
      } catch {
        return withoutComment.slice(1, -1);
      }
    }
    return withoutComment.slice(1, -1);
  }
  return undefined;
}
