import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { exists } from "./profile-runtime";

type JsonObject = Record<string, unknown>;

export interface ProjectStateSyncResult {
  changed: boolean;
  projects: number;
  restoredProjectMapping: boolean;
  threadAssignments: number;
}

const GLOBAL_STATE_NAME = ".codex-global-state.json";
/**
 * Restores the project/sidebar catalog without copying credentials, device state,
 * queued actions, or complete conversation metadata into an isolated profile.
 * Call only while the destination profile is stopped.
 */
export async function syncProjectStateFromMaster(options: {
  baseCodexHome: string;
  targetCodexHome: string;
}): Promise<ProjectStateSyncResult> {
  const sourcePath = path.join(options.baseCodexHome, GLOBAL_STATE_NAME);
  const targetPath = path.join(options.targetCodexHome, GLOBAL_STATE_NAME);
  const emptyResult: ProjectStateSyncResult = {
    changed: false,
    projects: 0,
    restoredProjectMapping: false,
    threadAssignments: 0,
  };
  if (
    path.resolve(sourcePath) === path.resolve(targetPath) ||
    !(await exists(sourcePath))
  ) {
    return emptyResult;
  }

  const source = await readJsonObject(sourcePath);
  if (!source) return emptyResult;
  const sourceProjects = asObject(source["local-projects"]);
  if (Object.keys(sourceProjects).length === 0) return emptyResult;

  await mkdir(options.targetCodexHome, { recursive: true, mode: 0o700 });
  const target = (await readJsonObject(targetPath)) ?? {};
  const before = JSON.stringify(target);

  mergeProjectCatalog(source, target);

  const targetThreadIds = readDatabaseIds(
    path.join(options.targetCodexHome, "state_5.sqlite"),
    "threads",
  );
  const targetProjectIds = readDatabaseIds(
    path.join(options.targetCodexHome, "state_5.sqlite"),
    "projects",
  );
  mergeThreadState(source, target, targetThreadIds);

  const sourceAtoms = asObject(source["electron-persisted-atom-state"]);
  const targetAtoms = asObject(target["electron-persisted-atom-state"]);
  mergeProjectAtoms(sourceAtoms, targetAtoms);
  for (const [key, value] of Object.entries(sourceAtoms)) {
    if (key.startsWith("sidebar-project-expanded-v1-")) {
      targetAtoms[key] = cloneJson(value);
    }
  }
  target["electron-persisted-atom-state"] = targetAtoms;

  const sourceHost = `local:${options.baseCodexHome}`;
  const targetHost = `local:${options.targetCodexHome}`;
  const sourceMappings = asObject(
    source["app-server-project-id-by-legacy-project-id-by-host"],
  );
  const targetMappings = asObject(
    target["app-server-project-id-by-legacy-project-id-by-host"],
  );
  const sourceMapping = asObject(sourceMappings[sourceHost]);
  const existingTargetMapping = asObject(targetMappings[targetHost]);
  const canReuseSourceMapping =
    Object.keys(existingTargetMapping).length === 0 &&
    Object.keys(sourceMapping).length > 0 &&
    Object.values(sourceMapping).every(
      (projectId) =>
        typeof projectId === "string" && targetProjectIds.has(projectId),
    );

  let restoredProjectMapping = false;
  if (canReuseSourceMapping) {
    targetMappings[targetHost] = cloneJson(sourceMapping);
    restoredProjectMapping = true;
  }
  if (Object.keys(targetMappings).length > 0) {
    target["app-server-project-id-by-legacy-project-id-by-host"] =
      targetMappings;
  }

  const sourceMigrations = asObject(
    source["app-server-projects-migration-by-host"],
  );
  const targetMigrations = asObject(
    target["app-server-projects-migration-by-host"],
  );
  if (canReuseSourceMapping) {
    const migration = cloneJson(asObject(sourceMigrations[sourceHost]));
    if (Array.isArray(migration.pendingThreadAssignmentIds)) {
      migration.pendingThreadAssignmentIds = migration.pendingThreadAssignmentIds.filter(
        (threadId) =>
          typeof threadId === "string" && targetThreadIds.has(threadId),
      );
    }
    migration.projectsMigrated = true;
    targetMigrations[targetHost] = migration;
  } else if (Object.keys(existingTargetMapping).length === 0) {
    // The copied local project catalog can be migrated by the destination app.
    // Clearing only this host's premature marker avoids the empty-catalog state.
    delete targetMigrations[targetHost];
  }
  target["app-server-projects-migration-by-host"] = targetMigrations;

  const after = JSON.stringify(target);
  if (after === before) {
    return {
      ...emptyResult,
      projects: Object.keys(sourceProjects).length,
      restoredProjectMapping,
      threadAssignments: countObject(target["thread-project-assignments"]),
    };
  }

  if (await exists(targetPath)) {
    await copyFile(
      targetPath,
      `${targetPath}.codex-deck-backup`,
      constants.COPYFILE_EXCL,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  await writeJsonAtomically(targetPath, target);
  return {
    changed: true,
    projects: Object.keys(sourceProjects).length,
    restoredProjectMapping,
    threadAssignments: countObject(target["thread-project-assignments"]),
  };
}

function mergeProjectCatalog(source: JsonObject, target: JsonObject): void {
  for (const key of [
    "electron-saved-workspace-roots",
    "project-order",
    "active-workspace-roots",
    "pinned-project-ids",
  ]) {
    const merged = mergeStringArrays(source[key], target[key]);
    if (merged.length > 0) target[key] = merged;
  }

  const sourceProjects = asObject(source["local-projects"]);
  const targetProjects = asObject(target["local-projects"]);
  target["local-projects"] = {
    ...cloneJson(targetProjects),
    ...cloneJson(sourceProjects),
  };

  const sourceAppearances = asObject(source["project-appearances"]);
  const targetAppearances = asObject(target["project-appearances"]);
  if (
    Object.keys(sourceAppearances).length > 0 ||
    Object.keys(targetAppearances).length > 0
  ) {
    target["project-appearances"] = {
      ...cloneJson(sourceAppearances),
      ...cloneJson(targetAppearances),
    };
  }
}

function mergeProjectAtoms(source: JsonObject, target: JsonObject): void {
  const sourcePreferences = asObject(
    source["flat-project-sidebar-preferences-v1"],
  );
  const targetPreferences = asObject(
    target["flat-project-sidebar-preferences-v1"],
  );
  if (
    Object.keys(sourcePreferences).length > 0 ||
    Object.keys(targetPreferences).length > 0
  ) {
    target["flat-project-sidebar-preferences-v1"] = {
      ...cloneJson(targetPreferences),
      mode: sourcePreferences.mode ?? targetPreferences.mode ?? "project",
      projectSortMode:
        sourcePreferences.projectSortMode ??
        targetPreferences.projectSortMode ??
        "updated_at",
      initialized: true,
    };
  }

  if (source["sidebar-project-list-expanded-v1"] !== undefined) {
    target["sidebar-project-list-expanded-v1"] = cloneJson(
      source["sidebar-project-list-expanded-v1"],
    );
  }
  const order = mergeStringArrays(
    source["unified-sidebar-project-order-v1"],
    target["unified-sidebar-project-order-v1"],
  );
  if (order.length > 0) target["unified-sidebar-project-order-v1"] = order;

  const sourceCollapsed = asObject(source["sidebar-collapsed-sections-v1"]);
  const targetCollapsed = asObject(target["sidebar-collapsed-sections-v1"]);
  if (
    Object.keys(sourceCollapsed).length > 0 ||
    Object.keys(targetCollapsed).length > 0
  ) {
    target["sidebar-collapsed-sections-v1"] = {
      ...cloneJson(targetCollapsed),
      threads: sourceCollapsed.threads ?? targetCollapsed.threads ?? false,
    };
  }
}

function mergeThreadState(
  source: JsonObject,
  target: JsonObject,
  targetThreadIds: Set<string>,
): void {
  for (const key of [
    "thread-workspace-root-hints",
    "thread-project-assignments",
    "thread-project-membership-host-ids",
  ]) {
    const sourceEntries = asObject(source[key]);
    const targetEntries = asObject(target[key]);
    for (const [threadId, value] of Object.entries(sourceEntries)) {
      if (targetThreadIds.has(threadId) && targetEntries[threadId] === undefined) {
        targetEntries[threadId] = cloneJson(value);
      }
    }
    if (Object.keys(targetEntries).length > 0) target[key] = targetEntries;
  }

  const existingProjectless = Array.isArray(target["projectless-thread-ids"])
    ? target["projectless-thread-ids"].filter(
        (threadId): threadId is string => typeof threadId === "string",
      )
    : [];
  const sourceProjectless = Array.isArray(source["projectless-thread-ids"])
    ? source["projectless-thread-ids"].filter(
        (threadId): threadId is string =>
          typeof threadId === "string" && targetThreadIds.has(threadId),
      )
    : [];
  const projectless = [...new Set([...existingProjectless, ...sourceProjectless])];
  if (projectless.length > 0) target["projectless-thread-ids"] = projectless;

  const sourceOrders = asObject(source["sidebar-project-thread-orders"]);
  const targetOrders = asObject(target["sidebar-project-thread-orders"]);
  for (const [projectId, rawOrder] of Object.entries(sourceOrders)) {
    if (!Array.isArray(rawOrder)) continue;
    const sourceOrder = rawOrder.filter(
      (threadId): threadId is string =>
        typeof threadId === "string" && targetThreadIds.has(threadId),
    );
    const targetOrder = Array.isArray(targetOrders[projectId])
      ? targetOrders[projectId].filter(
          (threadId): threadId is string => typeof threadId === "string",
        )
      : [];
    const merged = [...new Set([...sourceOrder, ...targetOrder])];
    if (merged.length > 0) targetOrders[projectId] = merged;
  }
  if (Object.keys(targetOrders).length > 0) {
    target["sidebar-project-thread-orders"] = targetOrders;
  }
}

function readDatabaseIds(
  databasePath: string,
  table: "threads" | "projects",
): Set<string> {
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database.prepare(`SELECT id FROM ${table}`).all() as Array<{
        id: string;
      }>;
      return new Set(rows.map((row) => row.id));
    } finally {
      database.close();
    }
  } catch {
    return new Set();
  }
}

async function readJsonObject(file: string): Promise<JsonObject | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return asObject(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJsonAtomically(file: string, value: JsonObject): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  await chmod(file, 0o600);
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function countObject(value: unknown): number {
  return Object.keys(asObject(value)).length;
}

function mergeStringArrays(source: unknown, target: unknown): string[] {
  const sourceValues = Array.isArray(source)
    ? source.filter((value): value is string => typeof value === "string")
    : [];
  const targetValues = Array.isArray(target)
    ? target.filter((value): value is string => typeof value === "string")
    : [];
  return [...new Set([...sourceValues, ...targetValues])];
}
