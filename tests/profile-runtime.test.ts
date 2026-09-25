import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exists,
  normalizeRuntimeConfig,
  prepareProfileRuntime,
} from "../electron/profile-runtime";
import type { Profile } from "../src/shared/types";
import { syncProjectStateFromMaster } from "../electron/project-state-sync";

function profile(overrides: Partial<Profile>): Profile {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Test",
    color: "#7CFFB2",
    provider: "chatgpt",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("profile runtime", () => {
  it("replaces obsolete imported model settings with managed DeepSeek values", () => {
    const config = normalizeRuntimeConfig(
      'cli_auth_credentials_store = "file"\npreferred_auth_method = "apikey"\nforced_login_method = "api"\nmodel_catalog_json = "/old/catalog.json"\nmodel = "deepseek-flash"\nreview_model = "deepseek-v4-flash"\nmodel_reasoning_effort = "xhigh"\n\n[desktop]\nfollowUpQueueMode = "queue"\nenabled-reasoning-efforts = ["low", "high"]\n\n[features]\nunified_exec = true\n',
      {
        model: "deepseek-v4-pro",
        modelCatalogPath: "/managed/deepseek-models.json",
        reasoningEffort: "high",
        removeReviewModel: true,
        desktopReasoningEfforts: [
          "low",
          "medium",
          "high",
          "xhigh",
          "ultra",
          "max",
        ],
      },
    );

    expect(config).not.toContain("/old/catalog.json");
    expect(config).toContain(
      'model_catalog_json = "/managed/deepseek-models.json"',
    );
    expect(config).toContain('model = "deepseek-v4-pro"');
    expect(config).toContain('model_reasoning_effort = "high"');
    expect(config).not.toContain("review_model");
    expect(config).not.toContain("preferred_auth_method");
    expect(config).not.toContain("forced_login_method");
    expect(config.match(/\[desktop\]/g)).toHaveLength(1);
    expect(config).toContain('followUpQueueMode = "queue"');
    expect(config).toContain(
      'enabled-reasoning-efforts = ["low","medium","high","xhigh","ultra","max"]',
    );
    expect(config).toContain("[features]\nunified_exec = true");
  });

  it("writes a validated DeepSeek model catalog for the desktop picker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-deepseek-"));
    const base = path.join(root, "current");
    const profiles = path.join(root, "profiles");
    await mkdir(base, { recursive: true });
    await writeFile(path.join(base, "auth.json"), '{"token":"current"}\n');

    const deepSeekProfile = profile({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      credentialKind: "api-key",
      runtimeMode: "isolated",
      configurationSource: "cc-switch",
    });
    const profileRoot = path.join(profiles, deepSeekProfile.id);
    await mkdir(profileRoot, { recursive: true });
    await writeFile(
      path.join(profileRoot, "imported-config.toml"),
      [
        'model_catalog_json = "/old/cc-switch-models.json"',
        'model = "deepseek-v4-flash"',
        'review_model = "deepseek-v4-flash"',
        'model_reasoning_effort = "xhigh"',
        'model_provider = "custom"',
        "",
        "[model_providers.custom]",
        'name = "deepseek"',
        'base_url = "https://api.deepseek.com"',
        'wire_api = "responses"',
        'env_key = "CODEX_DECK_API_KEY"',
      ].join("\n"),
    );
    const paths = await prepareProfileRuntime(profiles, base, deepSeekProfile);
    const config = await readFile(
      path.join(paths.codexHome, "config.toml"),
      "utf8",
    );
    const catalogPath = path.join(paths.codexHome, "deepseek-models.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
      models: Array<{ slug: string; experimental_supported_tools: string[] }>;
    };

    expect(config).toContain(
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    );
    expect(config).not.toContain("/old/cc-switch-models.json");
    expect(config).not.toContain("review_model");
    expect(config).toContain('model_reasoning_effort = "high"');
    expect(config.match(/\[desktop\]/g)).toHaveLength(1);
    expect(config).toContain(
      'enabled-reasoning-efforts = ["low","medium","high","xhigh","ultra","max"]',
    );
    expect(catalog.models.map((model) => model.slug)).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
    ]);
    expect(
      catalog.models.every((model) =>
        Array.isArray(model.experimental_supported_tools),
      ),
    ).toBe(true);
  });

  it("returns the untouched current Codex home for the native profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-runtime-"));
    const base = path.join(root, "current");
    await mkdir(base, { recursive: true });
    await writeFile(path.join(base, "config.toml"), "model = \"existing\"\n");

    const paths = await prepareProfileRuntime(
      path.join(root, "profiles"),
      base,
      profile({ runtimeMode: "native" }),
    );

    expect(paths.codexHome).toBe(base);
    expect(await readFile(path.join(base, "config.toml"), "utf8")).toContain(
      "existing",
    );
  });

  it("bootstraps the desktop shell for API profiles without overriding provider routing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-runtime-"));
    const base = path.join(root, "current");
    const profiles = path.join(root, "profiles");
    await mkdir(base, { recursive: true });
    await writeFile(path.join(base, "auth.json"), '{"token":"current"}\n');

    const apiProfile = profile({
      provider: "custom",
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      credentialKind: "api-key",
      runtimeMode: "isolated",
    });
    const apiHome = path.join(
      profiles,
      apiProfile.id,
      "codex-home",
    );
    const paths = await prepareProfileRuntime(profiles, base, apiProfile);
    expect(
      await readFile(path.join(paths.codexHome, "auth.json"), "utf8"),
    ).toContain("current");
    const config = await readFile(
      path.join(paths.codexHome, "config.toml"),
      "utf8",
    );
    expect(config).toContain('env_key = "CODEX_DECK_API_KEY"');
  });

  it("restores project folders while preserving isolated profile state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-project-state-"));
    const base = path.join(root, "current");
    const target = path.join(root, "isolated");
    await mkdir(base, { recursive: true });
    await mkdir(target, { recursive: true });
    const sourceHost = `local:${base}`;
    const targetHost = `local:${target}`;
    await writeFile(
      path.join(base, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          "local-one": {
            id: "local-one",
            name: "One",
            rootPaths: [path.join(root, "one")],
          },
        },
        "project-order": ["legacy-one"],
        "thread-project-assignments": {
          "keep-thread": { projectKind: "local", projectId: "local-one" },
          "skip-thread": { projectKind: "local", projectId: "local-one" },
        },
        "app-server-project-id-by-legacy-project-id-by-host": {
          [sourceHost]: { "legacy-one": "server-one" },
        },
        "app-server-projects-migration-by-host": {
          [sourceHost]: {
            version: 1,
            projectsMigrated: true,
            pendingThreadAssignmentIds: ["keep-thread", "skip-thread"],
          },
        },
        "electron-persisted-atom-state": {
          "flat-project-sidebar-preferences-v1": {
            mode: "project",
            projectSortMode: "manual",
          },
          "sidebar-project-list-expanded-v1": true,
          "sidebar-project-expanded-v1-codex:legacy-one": true,
        },
      }),
    );
    await writeFile(
      path.join(target, ".codex-global-state.json"),
      JSON.stringify({
        isolatedOnly: "preserve-me",
        "local-projects": {
          "isolated-project": { id: "isolated-project", name: "Only here" },
        },
        "app-server-projects-migration-by-host": {
          [targetHost]: { version: 1, projectsMigrated: true },
        },
        "electron-persisted-atom-state": { isolatedAtom: true },
      }),
    );
    const database = new DatabaseSync(path.join(target, "state_5.sqlite"));
    database.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      INSERT INTO projects VALUES ('server-one');
      INSERT INTO threads VALUES ('keep-thread');
    `);
    database.close();

    const result = await syncProjectStateFromMaster({
      baseCodexHome: base,
      targetCodexHome: target,
    });
    const restored = JSON.parse(
      await readFile(path.join(target, ".codex-global-state.json"), "utf8"),
    ) as Record<string, any>;

    expect(result).toMatchObject({
      changed: true,
      projects: 1,
      restoredProjectMapping: true,
      threadAssignments: 1,
    });
    expect(restored.isolatedOnly).toBe("preserve-me");
    expect(restored["local-projects"]["local-one"].name).toBe("One");
    expect(restored["local-projects"]["isolated-project"].name).toBe(
      "Only here",
    );
    expect(
      restored["app-server-project-id-by-legacy-project-id-by-host"][targetHost],
    ).toEqual({ "legacy-one": "server-one" });
    expect(
      restored["app-server-projects-migration-by-host"][targetHost]
        .pendingThreadAssignmentIds,
    ).toEqual(["keep-thread"]);
    expect(Object.keys(restored["thread-project-assignments"])).toEqual([
      "keep-thread",
    ]);
    expect(restored["electron-persisted-atom-state"].isolatedAtom).toBe(true);
    expect(
      restored["electron-persisted-atom-state"][
        "sidebar-project-list-expanded-v1"
      ],
    ).toBe(true);
    expect(
      await readFile(
        path.join(target, ".codex-global-state.json.codex-deck-backup"),
        "utf8",
      ),
    ).toContain("preserve-me");
  });

  it("lets a fresh isolated profile migrate the copied project catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-project-fresh-"));
    const base = path.join(root, "current");
    const target = path.join(root, "isolated");
    await mkdir(base, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(
      path.join(base, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": { "local-one": { id: "local-one", name: "One" } },
        "app-server-project-id-by-legacy-project-id-by-host": {
          [`local:${base}`]: { "legacy-one": "server-one" },
        },
        "electron-persisted-atom-state": {},
      }),
    );
    await writeFile(
      path.join(target, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {},
        "app-server-projects-migration-by-host": {
          [`local:${target}`]: { version: 1, projectsMigrated: true },
        },
      }),
    );

    const result = await syncProjectStateFromMaster({
      baseCodexHome: base,
      targetCodexHome: target,
    });
    const restored = JSON.parse(
      await readFile(path.join(target, ".codex-global-state.json"), "utf8"),
    ) as Record<string, any>;

    expect(result.restoredProjectMapping).toBe(false);
    expect(
      restored["app-server-projects-migration-by-host"][`local:${target}`],
    ).toBeUndefined();
    expect(restored["local-projects"]["local-one"].name).toBe("One");
  });
});
