import { describe, expect, it } from "vitest";
import {
  buildLaunchSpec,
  parseIsolatedDesktopPid,
  parseNativeDesktopPid,
  sanitizeEnvironment,
} from "../electron/launcher";

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

  it("keeps the native profile on the existing Codex state", () => {
    const spec = buildLaunchSpec(
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      {
        root: "/Users/test/.codex",
        codexHome: "/Users/test/.codex",
        browserData: "",
      },
      null,
      "native",
    );
    expect(spec.args).toEqual([]);
    expect(spec.env.CODEX_HOME).toBeUndefined();
    expect(spec.env.CODEX_SQLITE_HOME).toBeUndefined();
  });

  it("finds the original desktop process without selecting isolated instances", () => {
    const executable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    const processes = [
      ` 201 ${executable} --user-data-dir=/profiles/one/browser-data`,
      ` 3171 ${executable}`,
      ` 3174 ${executable.replace("/MacOS/ChatGPT", "/Helpers/service")}`,
    ].join("\n");

    expect(parseNativeDesktopPid(processes, executable)).toBe(3171);
  });

  it("finds an isolated instance by its user data directory", () => {
    const executable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    const browserData = "/profiles/two/browser-data";
    const processes = [
      ` 201 ${executable} --user-data-dir=/profiles/one/browser-data`,
      ` 3171 ${executable}`,
      ` 3180 ${executable} --user-data-dir=${browserData}`,
    ].join("\n");

    expect(
      parseIsolatedDesktopPid(processes, executable, browserData),
    ).toBe(3180);
  });
});
