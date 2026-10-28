/**
 * The 设置 → 界面 switch for background-completion attention (r27-N3).
 *
 * A local view preference like `ui.ts`'s navigation: it changes what this window
 * does, not what the backend does, so it lives in localStorage rather than the
 * Rust config (which is a closed struct and would need a migration for one bool).
 */
import { create } from "zustand";

export const ATTENTION_KEY = "devhub.attention.v1";

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ATTENTION_KEY) !== "off";
  } catch {
    return true;
  }
}

function persist(enabled: boolean): void {
  try {
    localStorage.setItem(ATTENTION_KEY, enabled ? "on" : "off");
  } catch {
    // A full/blocked storage must not turn a preference into an error.
  }
}

type AttentionState = {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
};

export const useAttention = create<AttentionState>((set) => ({
  enabled: typeof localStorage === "undefined" ? true : readEnabled(),
  setEnabled: (enabled) => {
    persist(enabled);
    set({ enabled });
  },
}));
