import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  refreshCcSwitchAuth,
  sanitizeImportedConfig,
  scanCcSwitch,
} from "../electron/cc-switch-importer";
import { ProfileStore } from "../electron/profile-store";
import type { Profile } from "../src/shared/types";

async function createCcSwitchFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cc-switch-import-test-"));
  const databasePath = path.join(root, "cc-switch.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      sort_index INTEGER,
      PRIMARY KEY (id, app_type)
    )
  `);
  const insert = database.prepare(
    "INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index) VALUES (?, 'codex', ?, ?, ?, ?)",
  );
  insert.run(
    "oauth-one",
    "Work",
    JSON.stringify({
      auth: {
        OPENAI_API_KEY: null,
        auth_mode: "chatgpt",
        tokens: { access_token: "dummy-access", refresh_token: "dummy-refresh" },
      },
      config: 'model = "gpt-test"\n',
    }),
    1,
    0,
  );
  insert.run(
    "api-one",
    "DeepSeek",
    JSON.stringify({
      auth: { OPENAI_API_KEY: "sk-test-not-real" },
      config: [
        'model_provider = "custom"',
        'model = "deepseek-test"',
        "[model_providers.custom]",
        'base_url = "https://api.example.com/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
      ].join("\n"),
    }),
    0,
    1,
  );
  insert.run(
    "api-http",
    "Unsafe HTTP",
    JSON.stringify({
      auth: { OPENAI_API_KEY: "sk-unsafe-not-real" },
      config: [
        'model_provider = "custom"',
        'model = "unsafe"',
        "[model_providers.custom]",
        'base_url = "http://remote.example.com/v1"',
      ].join("\n"),
    }),
    0,
    2,
  );
  database.close();
  return databasePath;
}

describe("CC Switch importer", () => {
  it("discovers providers without returning credential contents", async () => {
    const databasePath = await createCcSwitchFixture();
    const existing: Profile = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Existing",
      color: "#7CFFB2",
      provider: "chatgpt",
      configurationSource: "cc-switch",
      importedFrom: { kind: "cc-switch", providerId: "oauth-one" },
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
    };
    const scan = await scanCcSwitch([existing], databasePath);

    expect(scan.found).toBe(true);
    expect(scan.candidates).toHaveLength(3);
    expect(scan.candidates.find((item) => item.sourceId === "oauth-one")?.alreadyImported).toBe(true);
    expect(scan.candidates.find((item) => item.sourceId === "api-one")?.credentialKind).toBe("api-key");
    expect(scan.candidates.find((item) => item.sourceId === "api-http")?.compatible).toBe(false);
    expect(JSON.stringify(scan)).not.toContain("dummy-access");
    expect(JSON.stringify(scan)).not.toContain("sk-test-not-real");
  });

  it("rewrites imported API auth to the encrypted runtime environment", () => {
    const config = sanitizeImportedConfig({
      credentialKind: "api-key",
      modelProvider: "custom",
      config: [
        'model_provider = "custom"',
        'model_catalog_json = "/old/catalog.json"',
        "[model_providers.custom]",
        'base_url = "https://api.example.com/v1"',
        'experimental_bearer_token = "plain-secret"',
        "requires_openai_auth = true",
        "[mcp_servers.example.env]",
        'CODEX_HOME = "/global/.codex"',
        'OPENAI_API_KEY = "plain-key"',
      ].join("\n"),
    });

    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).not.toContain("model_catalog_json");
    expect(config).toContain('env_key = "CODEX_DECK_API_KEY"');
    expect(config).not.toContain("plain-secret");
    expect(config).not.toContain("plain-key");
    expect(config).not.toContain("/global/.codex");
    expect(config).not.toContain("requires_openai_auth");
  });

  it("re-injects an imported OAuth login state into the isolated profile", async () => {
    const databasePath = await createCcSwitchFixture();
    const root = await mkdtemp(path.join(tmpdir(), "cc-switch-auth-test-"));
    const encryption = {
      isAvailable: () => true,
      encrypt: (value: string) => Buffer.from(`sealed:${value}`),
      decrypt: (value: Buffer) => value.toString().replace(/^sealed:/, ""),
    };
    const store = new ProfileStore(root, encryption);
    await store.initialize();
    const profile = await store.saveImported({
      sourceProviderId: "oauth-one",
      name: "Imported OAuth",
      color: "#7CFFB2",
      provider: "chatgpt",
      credentialKind: "oauth",
    });

    const result = await refreshCcSwitchAuth({
      profile,
      profileStore: store,
      baseCodexHome: path.join(root, "base-codex-home"),
      databasePath,
    });

    expect(result.credentialKind).toBe("oauth");
    const auth = JSON.parse(
      await readFile(
        path.join(
          store.profileDirectory(profile.id),
          "codex-home/auth.json",
        ),
        "utf8",
      ),
    ) as { tokens?: { access_token?: string } };
    expect(auth.tokens?.access_token).toBe("dummy-access");
  });
});
