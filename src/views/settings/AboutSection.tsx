import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Globe, Info, RefreshCw } from "lucide-react";
import { SettingsGroup, SettingRow } from "../../components/SettingsRows";
import { openHttpUrl } from "../../lib/external-url";
import { fmtTime } from "../../lib/format";
import { messageOf } from "../../lib/report-error";
import { useI18n } from "../../lib/useI18n";
import type { AppUpdate, WebView2Info } from "../../types";

/**
 * 设置 → 关于: current version and a read-only release check.
 *
 * The check never downloads or replaces the executable; the result is a release
 * link. That boundary is deliberate: an actual in-app update needs a signed
 * manifest, rollback and a code-signing identity, none of which exists yet.
 */
export function AboutSection() {
  const { t } = useI18n();
  const [version, setVersion] = useState<string | null>(null);
  const [webview2, setWebview2] = useState<WebView2Info | null>(null);
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void invoke<string>("app_version")
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {
        if (alive) setVersion(null);
      });
    void invoke<WebView2Info>("webview2_info")
      .then((v) => {
        if (alive) setWebview2(v);
      })
      .catch(() => {
        if (alive) setWebview2(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const check = async (force = false) => {
    setChecking(true);
    setError(null);
    try {
      const result = await invoke<AppUpdate>("check_app_update", { force });
      setUpdate(result);
    } catch (e) {
      setUpdate(null);
      setError(messageOf(e));
    } finally {
      setChecking(false);
    }
  };

  const checkedAt =
    update?.checkedAt != null
      ? fmtTime(update.checkedAt * 1000)
      : null;

  return (
    <div data-section="about" className="scroll-mt-3">
      <SettingsGroup title={t("about.groupTitle")}>
        <SettingRow
          icon={<Info className="h-4 w-4" />}
          title={t("about.versionTitle")}
          rowHint={version ? `v${version}` : "—"}
          hint={t("about.versionHint")}
        />
        <SettingRow
          icon={<Globe className="h-4 w-4" />}
          title={t("about.webview2Title")}
          rowHint={
            webview2 === null
              ? "—"
              : (webview2.version ?? t("about.webview2Missing"))
          }
          hint={
            webview2 !== null && webview2.version === null
              ? t("about.webview2MissingHint")
              : t("about.webview2Hint")
          }
        />
        <SettingRow
          icon={<RefreshCw className="h-4 w-4" />}
          title={t("about.checkTitle")}
          hint={
            update
              ? update.available
                ? t("about.available", { version: update.latest })
                : t("about.upToDate", { version: update.latest })
              : t("about.checkHint")
          }
          control={
            <div className="flex items-center gap-2">
              {update?.available && (
                <button
                  type="button"
                  onClick={() => void openHttpUrl(update.url)}
                  className="skin-ctl flex items-center gap-1 border border-border px-2 py-1 text-caption transition-colors hover:bg-accent"
                >
                  <Download className="h-3 w-3" />
                  {t("about.openRelease")}
                </button>
              )}
              {update && (
                <button
                  type="button"
                  onClick={() => void check(true)}
                  disabled={checking}
                  title={t("about.forceHint")}
                  className="text-caption text-muted-foreground underline decoration-dotted transition-colors hover:text-foreground disabled:opacity-40"
                >
                  {t("about.forceCheck")}
                </button>
              )}
              <button
                type="button"
                onClick={() => void check()}
                disabled={checking}
                className="skin-ctl flex items-center gap-1 border border-border px-2 py-1 text-caption transition-colors hover:bg-accent disabled:opacity-40"
              >
                <RefreshCw className={`h-3 w-3 ${checking ? "animate-spin" : ""}`} />
                {checking ? t("about.checking") : t("about.check")}
              </button>
            </div>
          }
        />
        {error && (
          <p role="alert" className="border-t border-border-weak px-3 py-2 text-caption text-danger">
            {t("about.failed", { msg: error })}
          </p>
        )}
        {checkedAt && (
          <p className="border-t border-border-weak px-3 py-2 text-caption text-muted-foreground">
            {t("about.checkedAt", { time: checkedAt })}
            {update?.fromCache ? ` · ${t("about.cached")}` : ""}
          </p>
        )}
        {update?.available && update.notes.trim() && (
          <pre className="max-h-40 overflow-auto border-t border-border-weak px-3 py-2 font-sans text-caption leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {update.notes.trim().slice(0, 1200)}
          </pre>
        )}
        {update?.prerelease && (
          <p className="border-t border-border-weak px-3 py-2 text-caption text-warning">
            {t("about.prerelease")}
          </p>
        )}
      </SettingsGroup>
    </div>
  );
}
