import { create } from "zustand";
import type { DownloadTask } from "./downloads";
import {
  HISTORY_CAP,
  captureHistory,
  readHistory,
  writeHistory,
  type HistoryEntry,
} from "../lib/download-history";

type HistoryState = {
  entries: HistoryEntry[];
  /** Record one settled task. Queued/running/failed rows are ignored. */
  record: (task: DownloadTask) => void;
  clear: () => void;
};

export const useDownloadHistory = create<HistoryState>((set, get) => ({
  entries: readHistory(),
  record: (task) => {
    const [entry] = captureHistory([task]);
    if (!entry) return;
    const entries = [entry, ...get().entries.filter((e) => e.id !== entry.id)].slice(0, HISTORY_CAP);
    writeHistory(entries);
    set({ entries });
  },
  clear: () => {
    writeHistory([]);
    set({ entries: [] });
  },
}));
