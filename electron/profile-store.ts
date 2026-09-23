import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type {
  CredentialKind,
  Profile,
  ProfileInput,
  ProviderKind,
} from "../src/shared/types";
import { validateProfileInput } from "./validation";

export interface EncryptionAdapter {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

interface ProfileFile {
  version: 1;
  profiles: Profile[];
}

interface SecretFile {
  version: 1;
  secrets: Record<string, string>;
}

export class ProfileStore {
  readonly profilesDir: string;
  private readonly profileFile: string;
  private readonly secretFile: string;

  constructor(
    readonly dataRoot: string,
    private readonly encryption: EncryptionAdapter,
  ) {
    this.profilesDir = path.join(dataRoot, "profiles");
    this.profileFile = path.join(dataRoot, "profiles.json");
    this.secretFile = path.join(dataRoot, "secrets.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.profilesDir, { recursive: true, mode: 0o700 });
  }

  async list(): Promise<Profile[]> {
    const data = await this.readJson<ProfileFile>(this.profileFile, {
      version: 1,
      profiles: [],
    });
    return data.profiles;
  }

  async get(id: string): Promise<Profile> {
    const profile = (await this.list()).find((entry) => entry.id === id);
    if (!profile) throw new Error("找不到这个配置。");
    return profile;
  }

  async save(input: ProfileInput): Promise<Profile> {
    const normalized = validateProfileInput(input);
    if (normalized.apiKey && !this.encryption.isAvailable()) {
      throw new Error("系统安全存储当前不可用，不能保存 API Key。");
    }
    const data = await this.readJson<ProfileFile>(this.profileFile, {
      version: 1,
      profiles: [],
    });
    const now = new Date().toISOString();
    const existingIndex = normalized.id
      ? data.profiles.findIndex((entry) => entry.id === normalized.id)
      : -1;
    const existing = existingIndex >= 0 ? data.profiles[existingIndex] : null;
    const id = existing?.id ?? randomUUID();
    const providerSettingsChanged = existing
      ? existing.provider !== normalized.provider ||
        (normalized.provider !== "chatgpt" &&
          (existing.baseUrl !== normalized.baseUrl ||
            existing.model !== normalized.model))
      : false;
    const keepImportedConfiguration =
      existing?.configurationSource === "cc-switch" &&
      !providerSettingsChanged;

    const profile: Profile = {
      id,
      name: normalized.name,
      color: normalized.color,
      provider: normalized.provider,
      baseUrl: keepImportedConfiguration
        ? existing?.baseUrl
        : normalized.provider === "chatgpt"
          ? undefined
          : normalized.baseUrl,
      model: keepImportedConfiguration
        ? existing?.model
        : normalized.provider === "chatgpt"
          ? undefined
          : normalized.model,
      credentialKind: keepImportedConfiguration
        ? existing?.credentialKind
        : normalized.provider === "chatgpt"
          ? "oauth"
          : "api-key",
      configurationSource: keepImportedConfiguration ? "cc-switch" : "managed",
      importedFrom: existing?.importedFrom,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (existingIndex >= 0) data.profiles[existingIndex] = profile;
    else data.profiles.push(profile);

    await this.writeJson(this.profileFile, data);
    await mkdir(this.profileDirectory(id), { recursive: true, mode: 0o700 });

    if (normalized.apiKey) {
      await this.setSecret(id, normalized.apiKey);
    } else if (normalized.provider === "chatgpt") {
      await this.removeSecret(id);
    }

    return profile;
  }

  async saveImported(input: {
    sourceProviderId: string;
    name: string;
    color: string;
    provider: ProviderKind;
    baseUrl?: string;
    model?: string;
    credentialKind: CredentialKind;
    apiKey?: string;
  }): Promise<Profile> {
    const existing = (await this.list()).find(
      (profile) =>
        profile.importedFrom?.kind === "cc-switch" &&
        profile.importedFrom.providerId === input.sourceProviderId,
    );
    if (existing) throw new Error("这个 CC Switch 配置已经导入。");

    const created = await this.save({
      name: input.name,
      color: input.color,
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
    });
    const data = await this.readJson<ProfileFile>(this.profileFile, {
      version: 1,
      profiles: [],
    });
    const index = data.profiles.findIndex((profile) => profile.id === created.id);
    if (index < 0) throw new Error("导入后的配置没有写入索引。");
    const imported: Profile = {
      ...data.profiles[index],
      baseUrl: input.baseUrl,
      model: input.model,
      credentialKind: input.credentialKind,
      configurationSource: "cc-switch",
      importedFrom: { kind: "cc-switch", providerId: input.sourceProviderId },
    };
    data.profiles[index] = imported;
    await this.writeJson(this.profileFile, data);
    return imported;
  }

  async remove(id: string): Promise<string> {
    const data = await this.readJson<ProfileFile>(this.profileFile, {
      version: 1,
      profiles: [],
    });
    if (!data.profiles.some((entry) => entry.id === id)) {
      throw new Error("找不到这个配置。");
    }
    data.profiles = data.profiles.filter((entry) => entry.id !== id);
    await this.writeJson(this.profileFile, data);
    await this.removeSecret(id);
    return this.profileDirectory(id);
  }

  profileDirectory(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("配置 ID 无效。");
    return path.join(this.profilesDir, id);
  }

  async hasSecret(id: string): Promise<boolean> {
    const data = await this.readJson<SecretFile>(this.secretFile, {
      version: 1,
      secrets: {},
    });
    return Boolean(data.secrets[id]);
  }

  async getSecret(id: string): Promise<string | null> {
    const data = await this.readJson<SecretFile>(this.secretFile, {
      version: 1,
      secrets: {},
    });
    const encrypted = data.secrets[id];
    if (!encrypted) return null;
    if (!this.encryption.isAvailable()) {
      throw new Error("系统安全存储当前不可用，无法读取 API Key。");
    }
    return this.encryption.decrypt(Buffer.from(encrypted, "base64"));
  }

  private async setSecret(id: string, value: string): Promise<void> {
    if (!this.encryption.isAvailable()) {
      throw new Error("系统安全存储当前不可用，不能保存 API Key。");
    }
    const data = await this.readJson<SecretFile>(this.secretFile, {
      version: 1,
      secrets: {},
    });
    data.secrets[id] = this.encryption.encrypt(value).toString("base64");
    await this.writeJson(this.secretFile, data, 0o600);
  }

  private async removeSecret(id: string): Promise<void> {
    const data = await this.readJson<SecretFile>(this.secretFile, {
      version: 1,
      secrets: {},
    });
    if (!(id in data.secrets)) return;
    delete data.secrets[id];
    await this.writeJson(this.secretFile, data, 0o600);
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  private async writeJson(
    file: string,
    value: unknown,
    mode = 0o600,
  ): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  }
}
