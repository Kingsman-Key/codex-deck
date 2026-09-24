import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type {
  CcSwitchCandidate,
  CcSwitchAuthRefreshResult,
  CcSwitchImportResult,
  CcSwitchScanResult,
  CredentialKind,
  Profile,
  ProviderKind,
} from "../src/shared/types";
import { ProfileStore } from "./profile-store";
import {
  exists,
  getProfilePaths,
  prepareProfileRuntime,
  type ProfilePaths,
} from "./profile-runtime";
import { validateProfileInput } from "./validation";

const IMPORT_COLORS = ["#7CFFB2", "#A8C7FA", "#C4A7FF", "#FFB86B", "#FF8C9B"];

interface CcSwitchRow {
  id: string;
  name: string;
  settings_config: string;
  is_current: number;
}

interface CcSwitchSettings {
  auth?: Record<string, unknown>;
  config?: string;
  modelCatalog?: unknown;
}

export interface CcSwitchProviderRecord {
  sourceId: string;
  name: string;
  credentialKind: CredentialKind | "unknown";
  config: string;
  auth: Record<string, unknown>;
  modelCatalog?: unknown;
  model?: string;
  modelProvider?: string;
  baseUrl?: string;
  isCurrent: boolean;
}

export async function findCcSwitchDatabase(): Promise<string | null> {
  const candidates = [
    process.env.CC_SWITCH_HOME
      ? path.join(process.env.CC_SWITCH_HOME, "cc-switch.db")
      : null,
    path.join(homedir(), ".cc-switch", "cc-switch.db"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export async function scanCcSwitch(
  profiles: Profile[],
  databasePath?: string | null,
): Promise<CcSwitchScanResult> {
  const resolvedPath = databasePath ?? (await findCcSwitchDatabase());
  if (!resolvedPath) return { found: false, candidates: [] };

  try {
    const importedIds = new Set(
      profiles
        .filter((profile) => profile.importedFrom?.kind === "cc-switch")
        .map((profile) => profile.importedFrom!.providerId),
    );
    const records = readCcSwitchRecords(resolvedPath);
    return {
      found: true,
      databasePath: resolvedPath,
      candidates: records.map((record) =>
        toCandidate(record, importedIds.has(record.sourceId)),
      ),
    };
  } catch (error) {
    return {
      found: true,
      databasePath: resolvedPath,
      candidates: [],
      warning: `无法读取 CC Switch 数据库：${safeError(error)}`,
    };
  }
}

export async function importCcSwitchProviders(options: {
  sourceIds: string[];
  profileStore: ProfileStore;
  baseCodexHome: string;
  databasePath?: string | null;
}): Promise<{ imported: Profile[]; skipped: CcSwitchImportResult["skipped"] }> {
  const databasePath = options.databasePath ?? (await findCcSwitchDatabase());
  if (!databasePath) throw new Error("没有找到 CC Switch 数据库。");
  const selectedIds = new Set(options.sourceIds);
  if (selectedIds.size === 0) return { imported: [], skipped: [] };

  const existingIds = new Set(
    (await options.profileStore.list())
      .filter((profile) => profile.importedFrom?.kind === "cc-switch")
      .map((profile) => profile.importedFrom!.providerId),
  );
  const records = readCcSwitchRecords(databasePath).filter((record) =>
    selectedIds.has(record.sourceId),
  );
  const foundIds = new Set(records.map((record) => record.sourceId));
  const imported: Profile[] = [];
  const skipped: CcSwitchImportResult["skipped"] = [];

  for (const sourceId of selectedIds) {
    if (!foundIds.has(sourceId)) {
      skipped.push({ sourceId, reason: "CC Switch 中已找不到这个配置。" });
    }
  }

  for (const [index, record] of records.entries()) {
    const candidate = toCandidate(record, existingIds.has(record.sourceId));
    if (candidate.alreadyImported || !candidate.compatible) {
      skipped.push({
        sourceId: record.sourceId,
        reason: candidate.alreadyImported
          ? "已经导入。"
          : candidate.reason ?? "配置不兼容。",
      });
      continue;
    }

    let created: Profile | null = null;
    try {
      const provider = inferProviderKind(record);
      const apiKey =
        record.credentialKind === "api-key"
          ? stringValue(record.auth.OPENAI_API_KEY)
          : undefined;
      created = await options.profileStore.saveImported({
        sourceProviderId: record.sourceId,
        name: record.name,
        color: IMPORT_COLORS[index % IMPORT_COLORS.length],
        provider,
        baseUrl: record.baseUrl,
        model: record.model,
        credentialKind: record.credentialKind as CredentialKind,
        apiKey,
      });
      const paths = getProfilePaths(options.profileStore.profilesDir, created.id);
      await writeImportedArtifacts(paths, record);
      await prepareProfileRuntime(
        options.profileStore.profilesDir,
        options.baseCodexHome,
        created,
      );
      imported.push(created);
      existingIds.add(record.sourceId);
    } catch (error) {
      if (created) {
        await options.profileStore.remove(created.id).catch(() => undefined);
        await rm(options.profileStore.profileDirectory(created.id), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
      skipped.push({ sourceId: record.sourceId, reason: safeError(error) });
    }
  }

  return { imported, skipped };
}

export async function refreshCcSwitchAuth(options: {
  profile: Profile;
  profileStore: ProfileStore;
  baseCodexHome: string;
  databasePath?: string | null;
}): Promise<CcSwitchAuthRefreshResult> {
  if (options.profile.importedFrom?.kind !== "cc-switch") {
    throw new Error("这个配置不是从 CC Switch 导入的。");
  }
  const databasePath =
    options.databasePath ?? (await findCcSwitchDatabase());
  if (!databasePath) throw new Error("没有找到 CC Switch 数据库。");
  const record = readCcSwitchRecords(databasePath).find(
    (item) => item.sourceId === options.profile.importedFrom?.providerId,
  );
  if (!record) {
    throw new Error("CC Switch 中已经找不到这个来源配置。");
  }
  if (record.credentialKind === "unknown") {
    throw new Error("这个 CC Switch 配置没有可用的登录态或 API Key。");
  }

  const paths = getProfilePaths(
    options.profileStore.profilesDir,
    options.profile.id,
  );
  await writeImportedArtifacts(paths, record);
  if (record.credentialKind === "api-key") {
    const apiKey = stringValue(record.auth.OPENAI_API_KEY);
    if (!apiKey) throw new Error("这个 CC Switch 配置缺少 API Key。");
    await options.profileStore.save({
      id: options.profile.id,
      name: options.profile.name,
      color: options.profile.color,
      provider: options.profile.provider,
      baseUrl: options.profile.baseUrl,
      model: options.profile.model,
      apiKey,
      autoSync: options.profile.autoSync,
    });
  }
  await prepareProfileRuntime(
    options.profileStore.profilesDir,
    options.baseCodexHome,
    options.profile,
  );
  return {
    sourceId: record.sourceId,
    name: record.name,
    credentialKind: record.credentialKind,
  };
}

export function readCcSwitchRecords(databasePath: string): CcSwitchProviderRecord[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const hasProviders = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'providers'",
      )
      .get() as { present?: number } | undefined;
    if (!hasProviders?.present) throw new Error("数据库中没有 providers 表。");

    const rows = database
      .prepare(
        `SELECT id, name, settings_config, is_current
         FROM providers
         WHERE app_type = 'codex'
         ORDER BY COALESCE(sort_index, 999999), name`,
      )
      .all() as unknown as CcSwitchRow[];

    return rows.map(parseCcSwitchRow);
  } finally {
    database.close();
  }
}

export function sanitizeImportedConfig(options: {
  config: string;
  credentialKind: CredentialKind;
  modelProvider?: string;
}): string {
  const output: string[] = ['cli_auth_credentials_store = "file"'];
  output.push("");

  const targetProviderSection = options.modelProvider
    ? `model_providers.${options.modelProvider}`
    : null;
  let currentSection: string | null = null;
  let insideTargetProvider = false;
  let injectedProviderAuth = false;

  const injectProviderAuth = () => {
    if (
      options.credentialKind === "api-key" &&
      insideTargetProvider &&
      !injectedProviderAuth
    ) {
      output.push('env_key = "CODEX_DECK_API_KEY"');
      injectedProviderAuth = true;
    }
  };

  for (const rawLine of options.config.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const section = parseSection(trimmed);
    if (section !== null) {
      injectProviderAuth();
      currentSection = section;
      insideTargetProvider =
        targetProviderSection !== null &&
        normalizeSection(section) === normalizeSection(targetProviderSection);
      output.push(rawLine);
      continue;
    }

    const assignment = parseAssignment(trimmed);
    if (!assignment) {
      output.push(rawLine);
      continue;
    }

    const normalizedKey = assignment.key.replace(/^['"]|['"]$/g, "").toUpperCase();
    if (
      normalizedKey === "CLI_AUTH_CREDENTIALS_STORE" ||
      normalizedKey === "CODEX_HOME" ||
      normalizedKey === "CODEX_SQLITE_HOME" ||
      normalizedKey === "OPENAI_API_KEY" ||
      normalizedKey === "CODEX_API_KEY" ||
      normalizedKey === "CODEX_ACCESS_TOKEN" ||
      normalizedKey === "MODEL_CATALOG_JSON" ||
      normalizedKey === "PREFERRED_AUTH_METHOD" ||
      normalizedKey === "FORCED_LOGIN_METHOD" ||
      /(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|BEARER_TOKEN|SECRET|PASSWORD)$/.test(
        normalizedKey,
      ) ||
      (insideTargetProvider &&
        options.credentialKind === "api-key" &&
        ["ENV_KEY", "REQUIRES_OPENAI_AUTH", "EXPERIMENTAL_BEARER_TOKEN"].includes(
          normalizedKey,
        ))
    ) {
      continue;
    }
    output.push(rawLine);
  }
  injectProviderAuth();

  if (options.credentialKind === "api-key" && !injectedProviderAuth) {
    throw new Error("API 配置缺少对应的 model_providers 区段。");
  }
  return `${output.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function parseCcSwitchRow(row: CcSwitchRow): CcSwitchProviderRecord {
  let settings: CcSwitchSettings;
  try {
    settings = JSON.parse(row.settings_config) as CcSwitchSettings;
  } catch {
    throw new Error(`CC Switch 配置“${row.name}”的 settings_config 不是有效 JSON。`);
  }
  const auth = isPlainObject(settings.auth) ? settings.auth : {};
  const config = typeof settings.config === "string" ? settings.config : "";
  const inspected = inspectToml(config);
  const apiKey = stringValue(auth.OPENAI_API_KEY);
  const tokens = isPlainObject(auth.tokens) ? auth.tokens : {};
  const hasOAuth = Boolean(
    stringValue(tokens.access_token) || stringValue(tokens.refresh_token),
  );
  return {
    sourceId: String(row.id),
    name: String(row.name),
    credentialKind: apiKey ? "api-key" : hasOAuth ? "oauth" : "unknown",
    config,
    auth,
    modelCatalog: settings.modelCatalog,
    model: inspected.model,
    modelProvider: inspected.modelProvider,
    baseUrl: inspected.baseUrl,
    isCurrent: Boolean(row.is_current),
  };
}

function toCandidate(
  record: CcSwitchProviderRecord,
  alreadyImported: boolean,
): CcSwitchCandidate {
  let compatible = record.credentialKind !== "unknown" && Boolean(record.config.trim());
  let reason: string | undefined;
  if (!compatible) reason = "没有可用的 API Key/OAuth 登录态或 TOML 配置。";

  if (compatible && record.credentialKind === "api-key") {
    try {
      validateProfileInput({
        name: record.name,
        color: IMPORT_COLORS[0],
        provider: inferProviderKind(record),
        baseUrl: record.baseUrl,
        model: record.model,
      });
      if (!record.modelProvider) {
        compatible = false;
        reason = "API 配置缺少 model_provider。";
      }
    } catch (error) {
      compatible = false;
      reason = safeError(error);
    }
  }

  if (compatible && record.baseUrl) {
    try {
      validateProfileInput({
        name: record.name,
        color: IMPORT_COLORS[0],
        provider: "custom",
        baseUrl: record.baseUrl,
        model: record.model ?? "imported-model",
      });
    } catch (error) {
      compatible = false;
      reason = safeError(error);
    }
  }

  return {
    sourceId: record.sourceId,
    name: record.name,
    credentialKind: record.credentialKind,
    model: record.model,
    baseUrl: record.baseUrl,
    isCurrent: record.isCurrent,
    alreadyImported,
    compatible,
    reason,
  };
}

function inferProviderKind(record: CcSwitchProviderRecord): ProviderKind {
  if (record.baseUrl?.includes("api.deepseek.com")) {
    return "deepseek";
  }
  if (
    record.baseUrl?.includes("openrouter.ai") &&
    record.model?.toLowerCase().includes("deepseek")
  ) {
    return "openrouter-deepseek";
  }
  return record.baseUrl || record.modelProvider ? "custom" : "chatgpt";
}

async function writeImportedArtifacts(
  paths: ProfilePaths,
  record: CcSwitchProviderRecord,
): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  const modelCatalogPath = record.modelCatalog
    ? path.join(paths.codexHome, "imported-model-catalog.json")
    : undefined;
  const config = sanitizeImportedConfig({
    config: record.config,
    credentialKind: record.credentialKind as CredentialKind,
    modelProvider: record.modelProvider,
  });
  const importedConfigPath = path.join(paths.root, "imported-config.toml");
  await writeFile(importedConfigPath, config, { mode: 0o600 });
  await chmod(importedConfigPath, 0o600);

  if (modelCatalogPath) {
    await writeFile(
      modelCatalogPath,
      `${JSON.stringify(record.modelCatalog, null, 2)}\n`,
      { mode: 0o600 },
    );
    await chmod(modelCatalogPath, 0o600);
  }

  if (record.credentialKind === "oauth") {
    const auth = { ...record.auth };
    delete auth.OPENAI_API_KEY;
    const authPath = path.join(paths.codexHome, "auth.json");
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(authPath, 0o600);
  }
}

function inspectToml(config: string): {
  model?: string;
  modelProvider?: string;
  baseUrl?: string;
} {
  let section: string | null = null;
  let model: string | undefined;
  let modelProvider: string | undefined;
  const baseUrls = new Map<string, string>();

  for (const rawLine of config.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const parsedSection = parseSection(trimmed);
    if (parsedSection !== null) {
      section = parsedSection;
      continue;
    }
    const assignment = parseAssignment(trimmed);
    if (!assignment) continue;
    const value = parseTomlString(assignment.value);
    if (!section && assignment.key === "model" && value) model = value;
    if (!section && assignment.key === "model_provider" && value) {
      modelProvider = value;
    }
    const providerId = providerIdFromSection(section);
    if (providerId && assignment.key === "base_url" && value) {
      baseUrls.set(providerId, value);
    }
    if (!section && assignment.key === "openai_base_url" && value) {
      baseUrls.set("openai", value);
    }
  }
  return {
    model,
    modelProvider,
    baseUrl: modelProvider ? baseUrls.get(modelProvider) : baseUrls.get("openai"),
  };
}

function parseSection(line: string): string | null {
  const match = line.match(/^\[([^\]]+)\](?:\s*#.*)?$/);
  return match ? match[1].trim() : null;
}

function parseAssignment(line: string): { key: string; value: string } | null {
  if (!line || line.startsWith("#")) return null;
  const match = line.match(/^([A-Za-z0-9_."'-]+)\s*=\s*(.+)$/);
  return match ? { key: match[1], value: match[2].trim() } : null;
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

function providerIdFromSection(section: string | null): string | null {
  if (!section) return null;
  const match = section.match(/^model_providers\.(.+)$/);
  return match ? match[1].replace(/^['"]|['"]$/g, "") : null;
}

function normalizeSection(section: string): string {
  const providerId = providerIdFromSection(section);
  return providerId ? `model_providers.${providerId}` : section;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
