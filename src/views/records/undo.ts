import {
  APPEARANCE_LABEL,
  APPEARANCE_VALUE_CHECKS,
  useAppearance,
  type Appearance,
} from "../../store/appearance";
import type { SettingsView as Settings } from "../../types";
import { buildSettingsPayload } from "../../lib/settings-payload";

/**
 * Round 13 (d4-3): the per-field validators moved down to the store that owns
 * the `Appearance` type, so `load()` / template import / export restore and this
 * undo path all check values against one table instead of one table plus three
 * ad-hoc merge rules. The old export name stays: this page's undo checks and the
 * tests below were written against it, and "the 记录 page's appearance keys" is
 * still what it means here.
 */
export const APPEARANCE_UNDO_CHECKS = APPEARANCE_VALUE_CHECKS;

/**
 * The 记录 page's `save_settings` payload.
 *
 * The required-and-replaced base (project_root / mirror / ip-pin / mirrors /
 * proxy + the token's "don't touch" pair) now comes from the shared
 * `buildSettingsPayload`, which bakes in the token rule so no page can silently
 * clear a token it never rendered. This page additionally re-affirms the two
 * settings it owns — extraRoots and activityRetentionDays — on every save; the
 * backend treats them as "set to this", and `patch` still wins because it is
 * spread last.
 */
export function settingsPayload(s: Settings, patch: Record<string, unknown>) {
  return {
    ...buildSettingsPayload(s),
    extraRoots: s.extraRoots,
    activityRetentionDays: s.activityRetentionDays,
    ...patch,
  };
}

/**
 * Applies a previous webview value.
 *
 * `ui.*` keys are namespaced `ui.<store>.<field>` so one descriptor shape covers
 * both zustand stores without the backend having to know either exists.
 *
 * The old version handed whatever `JSON.parse` produced straight to
 * `set(field as never, parsed as never)`: a corrupt or hand-edited `ui.*` undo
 * blob could write ANY store field, with the type system switched off and no
 * error shown. This is now an allowlist — every appearance key has one
 * validator, anything else is refused with a message the caller's catch turns
 * into a toast.
 */
export function applyUiValue(key: string, value: string) {
  if (!key.startsWith("ui.")) throw new Error(`未知的界面回退目标：${key}`);
  const [, store, field] = key.split(".");
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value);
  } catch {
    /* a plain string stays a string */
  }
  // No `ui.customize.*` record has ever been written (the only undo keys are the
  // three producers in appearance.ts), and the old branch was an unvalidated
  // `setState({ [field]: parsed })` — arbitrary-field write with no upside. It is
  // gone; an unknown store now says so instead of applying garbage.
  if (store !== "appearance") {
    throw new Error(`未知的界面存储：${store ?? ""}`);
  }
  if (field === "blob") {
    // 恢复默认/应用模版 carry the whole previous appearance. Under the loose
    // matcher this key fell through to set("blob", …), which restored nothing
    // and persisted a junk field into the store — restoreBlob is the only
    // honest target for a blob, and it takes the verified object's JSON.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("界面回退数据损坏：外观快照不是一个对象");
    }
    useAppearance.getState().restoreBlob(value);
    return;
  }
  if (!field || !(field in APPEARANCE_UNDO_CHECKS)) {
    throw new Error(`未知的界面回退字段：ui.appearance.${field ?? ""}`);
  }
  const k = field as keyof Appearance;
  if (!APPEARANCE_UNDO_CHECKS[k](parsed)) {
    throw new Error(
      `界面回退数据损坏：「${APPEARANCE_LABEL[k] ?? k}」的旧值与类型不符，已忽略`,
    );
  }
  useAppearance.getState().set(k, parsed as Appearance[keyof Appearance]);
}
