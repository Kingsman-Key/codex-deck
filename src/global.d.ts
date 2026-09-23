import type { CodexDeckApi } from "./shared/types";

declare global {
  interface Window {
    codexDeck: CodexDeckApi;
  }
}

export {};
