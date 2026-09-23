import { describe, expect, it } from "vitest";
import { generateProfileConfig } from "../electron/config-generator";
import type { Profile } from "../src/shared/types";

const baseProfile: Profile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Work",
  color: "#7CFFB2",
  provider: "chatgpt",
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
};

describe("generateProfileConfig", () => {
  it("keeps account profiles on the built-in provider", () => {
    const config = generateProfileConfig(baseProfile);
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).not.toContain("model_provider");
  });

  it("creates a Responses provider without embedding its secret", () => {
    const config = generateProfileConfig({
      ...baseProfile,
      provider: "openrouter-deepseek",
      model: "deepseek/deepseek-v4.1-flash",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(config).toContain('model = "deepseek/deepseek-v4.1-flash"');
    expect(config).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(config).toContain('env_key = "CODEX_DECK_API_KEY"');
    expect(config).toContain('wire_api = "responses"');
  });
});
