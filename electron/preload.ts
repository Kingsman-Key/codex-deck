import { contextBridge, ipcRenderer } from "electron";
import type { CodexDeckApi, ProfileInput } from "../src/shared/types";

const api: CodexDeckApi = {
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  saveProfile: (input: ProfileInput) => ipcRenderer.invoke("profiles:save", input),
  deleteProfile: (id: string) => ipcRenderer.invoke("profiles:delete", id),
  launchProfile: (id: string) => ipcRenderer.invoke("profiles:launch", id),
  quitProfile: (id: string) => ipcRenderer.invoke("profiles:quit", id),
  migrateProfileHistory: (id: string) =>
    ipcRenderer.invoke("profiles:migrate-history", id),
  syncProfileHistory: (id: string) =>
    ipcRenderer.invoke("profiles:sync-history", id),
  transferProfileHistory: (sourceId: string, targetId: string) =>
    ipcRenderer.invoke("profiles:transfer-history", sourceId, targetId),
  exportProfileHistory: (id: string) =>
    ipcRenderer.invoke("profiles:export-history", id),
  handoffProfileContext: (sourceId: string, targetId: string) =>
    ipcRenderer.invoke("profiles:handoff-context", sourceId, targetId),
  refreshCcSwitchAuth: (id: string) =>
    ipcRenderer.invoke("profiles:refresh-cc-switch-auth", id),
  getSystemStatus: () => ipcRenderer.invoke("system:status"),
  scanCcSwitch: () => ipcRenderer.invoke("cc-switch:scan"),
  importCcSwitch: (sourceIds: string[]) =>
    ipcRenderer.invoke("cc-switch:import", sourceIds),
  chooseExecutable: () => ipcRenderer.invoke("system:choose-executable"),
  openDataFolder: () => ipcRenderer.invoke("system:open-data-folder"),
  onProfilesChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("profiles:changed", listener);
    return () => ipcRenderer.removeListener("profiles:changed", listener);
  },
};

contextBridge.exposeInMainWorld("codexDeck", api);
