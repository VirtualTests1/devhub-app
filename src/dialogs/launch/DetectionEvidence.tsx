import { KIND_LABEL, type Candidate, type DetectionReport } from "../../types";
import { hasDanger, riskText } from "../../lib/launch-risk";
import { useI18n } from "../../lib/useI18n";

/** Shows the detection result *with its evidence*, which is the whole point of guessing. */
export function DetectionEvidence({
  report,
  onPick,
}: {
  report: DetectionReport;
  onPick: (c: Candidate) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-3">
      <div className="app-desc text-caption text-muted-foreground">
        {t("detect.recognized")}
        <span className="mx-1 rounded bg-muted px-1 text-foreground">
          {report.projectType ?? t("detect.unrecognized")}
        </span>
        {report.inspected.length > 0 &&
          t("detect.inspected", { list: report.inspected.slice(0, 6).join("、") })}
        {report.candidates.length > 0 && t("detect.pickHint")}
      </div>
      {report.candidates.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {report.candidates.slice(0, 6).map((c: Candidate, i) => {
            const hits = report.risks?.find((r) => r.command === c.command)?.hits ?? [];
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onPick(c)}
                  className="w-full rounded-lg border border-border-weak px-2 py-1.5 text-left transition-colors hover:border-primary/60 hover:bg-primary/10"
                >
                  <div className="flex items-center justify-between gap-2">
                    <code className="min-w-0 flex-1 truncate text-caption">{c.command}</code>
                    {hits.length > 0 && (
                      <span
                        className={
                          hasDanger(hits)
                            ? "shrink-0 rounded bg-danger/15 px-1 text-caption text-danger"
                            : "shrink-0 rounded bg-warning/15 px-1 text-caption text-warning"
                        }
                      >
                        {hits.map((h) => riskText(t, h.code)).join(t("launch.risk.separator"))}
                      </span>
                    )}
                    <span className="shrink-0 rounded bg-muted px-1 text-caption text-muted-foreground">
                      {KIND_LABEL[c.kind]}
                    </span>
                  </div>
                  <div
                    className="app-desc mt-0.5 truncate text-caption text-muted-foreground"
                    title={c.evidence}
                  >
                    {t("detect.evidence", { evidence: c.evidence })}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="app-desc mt-2 text-caption text-muted-foreground">{t("detect.noCandidates")}</p>
      )}
      {report.notes.map((n, i) => (
        <p key={i} className="app-desc mt-1 text-caption leading-snug text-muted-foreground">
          · {n}
        </p>
      ))}
    </div>
  );
}
