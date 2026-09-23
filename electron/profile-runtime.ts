import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Profile } from "../src/shared/types";
import { generateProfileConfig } from "./config-generator";

export interface ProfilePaths {
  root: string;
  codexHome: string;
  browserData: string;
}

export function getProfilePaths(profilesDir: string, id: string): ProfilePaths {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("配置 ID 无效。");
  const root = path.join(profilesDir, id);
  return {
    root,
    codexHome: path.join(root, "codex-home"),
    browserData: path.join(root, "browser-data"),
  };
}

export async function prepareProfileRuntime(
  profilesDir: string,
  baseCodexHome: string,
  profile: Profile,
): Promise<ProfilePaths> {
  const paths = getProfilePaths(profilesDir, profile.id);
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await mkdir(paths.browserData, { recursive: true, mode: 0o700 });
  const configPath = path.join(paths.codexHome, "config.toml");
  const importedConfigPath = path.join(paths.root, "imported-config.toml");
  const config =
    profile.configurationSource === "cc-switch" &&
    (await exists(importedConfigPath))
      ? await readFile(importedConfigPath, "utf8")
      : generateProfileConfig(profile);
  await writeFile(configPath, config, { mode: 0o600 });
  await chmod(configPath, 0o600);

  for (const sharedName of ["skills", "plugins"]) {
    const source = path.join(baseCodexHome, sharedName);
    const target = path.join(paths.codexHome, sharedName);
    if (!(await exists(source)) || (await exists(target))) continue;
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  }

  return paths;
}

export async function importCurrentAuth(
  baseCodexHome: string,
  destinationCodexHome: string,
): Promise<void> {
  const source = path.join(baseCodexHome, "auth.json");
  if (!(await exists(source))) {
    throw new Error("当前 Codex Home 中没有可导入的 auth.json；请直接启动后登录一次。");
  }
  const destination = path.join(destinationCodexHome, "auth.json");
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
}

export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
