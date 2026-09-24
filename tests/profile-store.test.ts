import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileStore } from "../electron/profile-store";

const encryption = {
  isAvailable: () => true,
  encrypt: (value: string) => Buffer.from(`sealed:${value}`),
  decrypt: (value: Buffer) => value.toString().replace(/^sealed:/, ""),
};

describe("ProfileStore", () => {
  it("creates one protected native profile for existing chats", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-test-"));
    const store = new ProfileStore(root, encryption);
    await store.initialize();
    const first = await store.ensureNativeProfile();
    const second = await store.ensureNativeProfile();

    expect(first.runtimeMode).toBe("native");
    expect(second.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
    await expect(store.remove(first.id)).rejects.toThrow("不能删除");
  });

  it("stores profile metadata separately from encrypted API keys", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-test-"));
    const store = new ProfileStore(root, encryption);
    await store.initialize();
    const profile = await store.save({
      name: "DeepSeek",
      color: "#7CFFB2",
      provider: "openrouter-deepseek",
      apiKey: "sk-test",
    });

    const metadata = await readFile(path.join(root, "profiles.json"), "utf8");
    const secrets = await readFile(path.join(root, "secrets.json"), "utf8");
    expect(metadata).not.toContain("sk-test");
    expect(secrets).not.toContain("sk-test");
    expect(await store.getSecret(profile.id)).toBe("sk-test");
  });

  it("persists the startup context auto-sync preference", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-test-"));
    const store = new ProfileStore(root, encryption);
    await store.initialize();
    const profile = await store.save({
      name: "Auto",
      color: "#7CFFB2",
      provider: "chatgpt",
      autoSync: "context",
    });

    expect((await store.get(profile.id)).autoSync).toBe("context");
  });

  it("enables history auto-sync for existing CC Switch imports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-test-"));
    const store = new ProfileStore(root, encryption);
    await store.initialize();
    await writeFile(
      path.join(root, "profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Imported",
            color: "#7CFFB2",
            provider: "custom",
            configurationSource: "cc-switch",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Imported OpenAI",
            color: "#7CFFB2",
            provider: "chatgpt",
            configurationSource: "cc-switch",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      }),
    );

    await store.enableAutoSyncForImportedProfiles();

    const profiles = await store.list();
    expect(profiles[0].autoSync).toBe("history");
    expect(profiles[1].autoSync).toBeUndefined();
  });

  it("upgrades legacy direct DeepSeek profiles to the current model id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-deck-test-"));
    const store = new ProfileStore(root, encryption);
    await store.initialize();
    await writeFile(
      path.join(root, "profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            name: "DeepSeek",
            color: "#7CFFB2",
            provider: "custom",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-v4-flash",
            credentialKind: "api-key",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      }),
    );

    await store.normalizeDeepSeekProfiles();

    const [profile] = await store.list();
    expect(profile.provider).toBe("deepseek");
    expect(profile.model).toBe("deepseek-flash");
  });
});
