import { describe, expect, it } from "vitest";
import { validateProfileInput } from "../electron/validation";

describe("validateProfileInput", () => {
  it("normalizes the official DeepSeek preset", () => {
    const input = validateProfileInput({
      name: " DeepSeek ",
      color: "#7cffb2",
      provider: "deepseek",
    });
    expect(input.name).toBe("DeepSeek");
    expect(input.color).toBe("#7CFFB2");
    expect(input.baseUrl).toBe("https://api.deepseek.com");
    expect(input.model).toBe("deepseek-flash");
  });

  it("upgrades the retired DeepSeek flash model id", () => {
    const input = validateProfileInput({
      name: "Imported DeepSeek",
      color: "#7CFFB2",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });

    expect(input.model).toBe("deepseek-flash");
  });

  it("rejects insecure remote endpoints", () => {
    expect(() =>
      validateProfileInput({
        name: "Unsafe",
        color: "#7CFFB2",
        provider: "custom",
        baseUrl: "http://api.example.com/v1",
        model: "example",
      }),
    ).toThrow("HTTPS");
  });

  it("allows a local HTTP proxy", () => {
    expect(
      validateProfileInput({
        name: "Local",
        color: "#7CFFB2",
        provider: "custom",
        baseUrl: "http://127.0.0.1:4000/v1/",
        model: "deepseek",
      }).baseUrl,
    ).toBe("http://127.0.0.1:4000/v1");
  });
});
