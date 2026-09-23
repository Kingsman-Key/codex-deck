import { describe, expect, it } from "vitest";
import { buildLaunchSpec, sanitizeEnvironment } from "../electron/launcher";

describe("launcher isolation", () => {
  it("removes inherited credential and Codex state variables", () => {
    expect(
      sanitizeEnvironment({
        PATH: "/bin",
        CODEX_HOME: "/unsafe",
        OPENAI_API_KEY: "secret",
        CODEX_ACCESS_TOKEN: "token",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  it("assigns independent application and Codex data roots", () => {
    const spec = buildLaunchSpec(
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      {
        root: "/profiles/one",
        codexHome: "/profiles/one/codex-home",
        browserData: "/profiles/one/browser-data",
      },
      "encrypted-at-rest-key",
    );
    expect(spec.args).toEqual(["--user-data-dir=/profiles/one/browser-data"]);
    expect(spec.env.CODEX_HOME).toBe("/profiles/one/codex-home");
    expect(spec.env.CODEX_SQLITE_HOME).toBe("/profiles/one/codex-home");
    expect(spec.env.CODEX_DECK_API_KEY).toBe("encrypted-at-rest-key");
  });
});
