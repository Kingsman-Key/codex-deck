import type { Profile } from "../src/shared/types";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function generateProfileConfig(profile: Profile): string {
  const header = [
    "# Managed by Codex Deck. Edit the profile in Codex Deck instead.",
    'cli_auth_credentials_store = "file"',
  ];

  if (profile.provider === "chatgpt") {
    return `${header.join("\n")}\n`;
  }

  const providerName =
    profile.provider === "openrouter-deepseek"
      ? "OpenRouter · DeepSeek"
      : "Custom Responses provider";

  return `${header.join("\n")}
model = ${tomlString(profile.model ?? "")}
model_provider = "deck_provider"

[model_providers.deck_provider]
name = ${tomlString(providerName)}
base_url = ${tomlString(profile.baseUrl ?? "")}
env_key = "CODEX_DECK_API_KEY"
wire_api = "responses"
`;
}
