import type { SettingsView } from "../types";

/**
 * The base `save_settings` payload: the fields the backend treats as
 * **required-and-replaced**, plus the token's "don't touch" markers.
 *
 * `SettingsUpdate` (src-tauri/src/lib.rs) requires `project_root`,
 * `mirror_enabled`, `ip_pin_enabled`, `mirrors` and `proxy` — a save that omits
 * any of them would reset it — while every other field is `Option` /
 * `#[serde(default)]` ("absent = keep as-is"). So the safe minimal base is
 * exactly these five, read from the current snapshot, and nothing else: sending
 * an optional field here would overwrite a possibly-newer backend value with a
 * stale frontend one. A caller changes an optional field by putting it in
 * `patch`.
 *
 * The token is never implicitly touched: `githubToken: ""` + `clearGithubToken:
 * false` is the backend's "leave the stored token alone" pair — the UI never
 * holds the raw token, so it cannot round-trip it. A caller that genuinely sets
 * or clears a token overrides these two via `patch`; nothing else may.
 */
export function buildSettingsPayload(
  s: Partial<SettingsView> | null | undefined,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectRoot: s?.projectRoot ?? "",
    mirrorEnabled: s?.mirrorEnabled ?? false,
    ipPinEnabled: s?.ipPinEnabled ?? true,
    mirrors: s?.mirrors ?? [],
    proxy: s?.proxy ?? "",
    githubToken: "",
    clearGithubToken: false,
    ...patch,
  };
}
