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
  it("removes obsolete imported model catalogs before Codex parses config", () => {
    const config = normalizeRuntimeConfig(
      'cli_auth_credentials_store = "file"\npreferred_auth_method = "apikey"\nforced_login_method = "api"\nmodel_catalog_json = "/old/catalog.json"\nmodel = "deepseek-flash"\n',
      "deepseek-v4-pro",
    );

    expect(config).not.toContain("model_catalog_json");
    expect(config).toContain('model = "deepseek-v4-pro"');
    expect(config).not.toContain("preferred_auth_method");
    expect(config).not.toContain("forced_login_method");
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
});
