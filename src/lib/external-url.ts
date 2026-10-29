import { messageOf } from "./report-error";
import { t } from "./i18n";
import { toast } from "../store/toast";

/**
 * The one rule for links the app hands to the operating system (r28-O3).
 *
 * `plugin-opener` can launch more than a browser if given a `file:` or a
 * protocol handler; repository markers and tool metadata are external input, so
 * every call goes through this allowlist instead of trusting the string. Only
 * absolute `http:`/`https:` URLs without userinfo are admitted. Relative paths,
 * `javascript:`, `data:`, `file:` and friends are refused with a visible error
 * at the call site.
 */
export function safeHttpUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.href;
}

/** Opens a link through the allowlist and reports a refusal/failure visibly. */
export async function openHttpUrl(raw: string): Promise<boolean> {
  const safe = safeHttpUrl(raw);
  if (!safe) {
    toast.error(t("app.linkBlocked"));
    return false;
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(safe);
    return true;
  } catch (e) {
    toast.error(t("app.openLinkFailed", { msg: messageOf(e) }));
    return false;
  }
}
