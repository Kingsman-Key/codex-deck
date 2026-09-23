import { contextBridge, ipcRenderer } from "electron";
import type { CodexDeckApi, ProfileInput } from "../src/shared/types";

const api: CodexDeckApi = {
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  saveProfile: (input: ProfileInput) => ipcRenderer.invoke("profiles:save", input),
  deleteProfile: (id: string) => ipcRenderer.invoke("profiles:delete", id),
  launchProfile: (id: string) => ipcRenderer.invoke("profiles:launch", id),
  quitProfile: (id: string) => ipcRenderer.invoke("profiles:quit", id),
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
