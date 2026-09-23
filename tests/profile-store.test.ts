import { mkdtemp, readFile } from "node:fs/promises";
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
});
