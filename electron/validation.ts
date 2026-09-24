import type { ProfileInput, ProviderKind } from "../src/shared/types";

const PROVIDERS = new Set<ProviderKind>([
  "chatgpt",
  "deepseek",
  "openrouter-deepseek",
  "custom",
]);

export interface ValidProfileInput extends ProfileInput {
  name: string;
  color: string;
  provider: ProviderKind;
}

export function validateProfileInput(input: ProfileInput): ValidProfileInput {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) {
    throw new Error("配置名称需要 1–40 个字符。");
  }

  if (!PROVIDERS.has(input.provider)) {
    throw new Error("不支持的服务商类型。");
  }

  const color = input.color.trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) {
    throw new Error("主题颜色必须是 6 位十六进制颜色。");
  }

  const normalized: ValidProfileInput = {
    ...input,
    name,
    color,
    apiKey: input.apiKey?.trim(),
    baseUrl: input.baseUrl?.trim().replace(/\/$/, ""),
    model: input.model?.trim(),
  };

  if (input.provider === "deepseek") {
    normalized.baseUrl = "https://api.deepseek.com";
    normalized.model ||= "deepseek-flash";
    if (
      normalized.model === "deepseek-v4-flash" ||
      normalized.model === "deepseek-v4-flash-vision-exp"
    ) {
      normalized.model = "deepseek-flash";
    }
  } else if (input.provider === "openrouter-deepseek") {
    normalized.baseUrl = "https://openrouter.ai/api/v1";
    normalized.model ||= "deepseek/deepseek-v4.1-flash";
  }

  if (input.provider !== "chatgpt") {
    if (!normalized.baseUrl || !normalized.model) {
      throw new Error("API 配置需要接口地址和模型名称。");
    }
    validateProviderUrl(normalized.baseUrl);
  }

  return normalized;
}

function validateProviderUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("接口地址不是有效 URL。");
  }

  const localHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("接口地址必须使用 HTTPS；本机 localhost 可使用 HTTP。");
  }
}
