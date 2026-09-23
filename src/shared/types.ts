export type ProviderKind = "chatgpt" | "openrouter-deepseek" | "custom";
export type CredentialKind = "oauth" | "api-key";

export interface ImportedProfileSource {
  kind: "cc-switch";
  providerId: string;
}

export interface Profile {
  id: string;
  name: string;
  color: string;
  provider: ProviderKind;
  baseUrl?: string;
  model?: string;
  credentialKind?: CredentialKind;
  configurationSource?: "managed" | "cc-switch";
  importedFrom?: ImportedProfileSource;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileInput {
  id?: string;
  name: string;
  color: string;
  provider: ProviderKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  importCurrentSession?: boolean;
}

export interface ProfileView extends Profile {
  running: boolean;
  hasApiKey: boolean;
}

export interface SystemStatus {
  platform: NodeJS.Platform;
  desktopExecutable: string | null;
  encryptionAvailable: boolean;
  dataRoot: string;
  codexHome: string;
}

export interface LaunchResult {
  status: "launched" | "focused";
  pid: number;
}

export interface CcSwitchCandidate {
  sourceId: string;
  name: string;
  credentialKind: CredentialKind | "unknown";
  model?: string;
  baseUrl?: string;
  isCurrent: boolean;
  alreadyImported: boolean;
  compatible: boolean;
  reason?: string;
}

export interface CcSwitchScanResult {
  found: boolean;
  databasePath?: string;
  candidates: CcSwitchCandidate[];
  warning?: string;
}

export interface CcSwitchImportResult {
  imported: ProfileView[];
  skipped: Array<{ sourceId: string; reason: string }>;
}

export interface CodexDeckApi {
  listProfiles(): Promise<ProfileView[]>;
  saveProfile(input: ProfileInput): Promise<ProfileView>;
  deleteProfile(id: string): Promise<void>;
  launchProfile(id: string): Promise<LaunchResult>;
  quitProfile(id: string): Promise<void>;
  getSystemStatus(): Promise<SystemStatus>;
  scanCcSwitch(): Promise<CcSwitchScanResult>;
  importCcSwitch(sourceIds: string[]): Promise<CcSwitchImportResult>;
  chooseExecutable(): Promise<string | null>;
  openDataFolder(): Promise<void>;
  onProfilesChanged(callback: () => void): () => void;
}
