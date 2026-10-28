import { invoke } from "@tauri-apps/api/core";
import { FALLBACK_FAMILIES, familyDisplay } from "../store/appearance";

/**
 * Where the 外观 font picker gets its list.
 *
 * The backend command `list_system_fonts` enumerates the registry (HKLM + HKCU
 * fonts), which is the honest "本机已安装" answer. When the command is not in
 * this build yet (it landed behind a write-guard; see the round-6 report), the
 * picker falls back to a curated common-families list and says so — the rows
 * still work, they are just not exhaustive.
 */

export type SystemFontList = {
  families: { family: string; display: string }[];
  source: "backend" | "fallback";
};

type BackendFont = { family: string; display: string };

export async function loadSystemFonts(): Promise<SystemFontList> {
  try {
    const backend = await invoke<BackendFont[]>("list_system_fonts");
    if (Array.isArray(backend) && backend.length > 0) {
      return {
        families: backend.map((f) => ({
          family: f.family,
          display: f.display || familyDisplay(f.family),
        })),
        source: "backend",
      };
    }
  } catch {
    /* command not registered in this build → fall through to the fallback */
  }
  return {
    families: FALLBACK_FAMILIES.map((f) => ({ family: f, display: familyDisplay(f) })),
    source: "fallback",
  };
}
