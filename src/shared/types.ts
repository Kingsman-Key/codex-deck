export type ProviderKind =
  | "chatgpt"
  | "deepseek"
  | "openrouter-deepseek"
  | "custom";
export type CredentialKind = "oauth" | "api-key";
export type RuntimeMode = "native" | "isolated";
export type AutoSyncMode = "off" | "context" | "history";

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
  runtimeMode?: RuntimeMode;
  autoSync?: AutoSyncMode;
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
  autoSync?: AutoSyncMode;
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

export interface HistoryMigrationResult {
  providerTag: string;
  matchedThreads: number;
  copiedSessions: number;
  missingSessions: number;
  targetThreads: number;
}

export interface HistoryTransferResult extends HistoryMigrationResult {
  sourceProviderTag: string;
}

export interface HistoryExportResult {
  directory: string;
  threadCount: number;
  copiedSessions: number;
  missingSessions: number;
}

export interface ContextHandoffResult {
  sourceName: string;
  targetName: string;
  targetStatus: "launched" | "focused";
  contextLength: number;
}

export interface CcSwitchAuthRefreshResult {
  sourceId: string;
  name: string;
  credentialKind: CredentialKind;
}

export interface CodexDeckApi {
  listProfiles(): Promise<ProfileView[]>;
  saveProfile(input: ProfileInput): Promise<ProfileView>;
  deleteProfile(id: string): Promise<void>;
  launchProfile(id: string): Promise<LaunchResult>;
  quitProfile(id: string): Promise<void>;
  migrateProfileHistory(id: string): Promise<HistoryMigrationResult>;
  syncProfileHistory(id: string): Promise<HistoryMigrationResult>;
  transferProfileHistory(
    sourceId: string,
    targetId: string,
  ): Promise<HistoryTransferResult>;
  exportProfileHistory(id: string): Promise<HistoryExportResult>;
  handoffProfileContext(
    sourceId: string,
    targetId: string,
  ): Promise<ContextHandoffResult>;
  refreshCcSwitchAuth(id: string): Promise<CcSwitchAuthRefreshResult>;
  getSystemStatus(): Promise<SystemStatus>;
  scanCcSwitch(): Promise<CcSwitchScanResult>;
  importCcSwitch(sourceIds: string[]): Promise<CcSwitchImportResult>;
  chooseExecutable(): Promise<string | null>;
  openDataFolder(): Promise<void>;
  onProfilesChanged(callback: () => void): () => void;
}
