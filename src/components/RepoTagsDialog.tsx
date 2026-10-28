import { useMemo, useState } from "react";
import { Plus, Tags, X } from "lucide-react";
import { DialogShell } from "./DialogShell";
import { cn } from "../lib/utils";
import { isCommitEnter } from "../lib/ime";
import { useI18n } from "../lib/useI18n";
import {
  REPO_TAG_LENGTH_LIMIT,
  REPO_TAG_LIMIT,
  addRepoTag,
  hasRepoTag,
  removeRepoTag,
  sanitiseTag,
  useWall,
  type RepoState,
} from "../store/wall";

/**
 * 一张卡片的标签编辑器（需求 N3-2）.
 *
 * ## Why a dialog and not the 项目设置 sheet
 *
 * `ProjectSettingsDialog` already owns 别名/封面/终止命令, and it loads
 * `repo_detail` over IPC before it can paint. Tagging is the opposite kind of
 * edit: it touches nothing on disk, needs no backend answer, and is the sort of
 * thing done to twelve cards in a row. Putting it behind that fetch would make the
 * cheapest action on the wall the slowest one, so it gets its own sheet that opens
 * the instant the menu row is chosen.
 *
 * ## Why it commits per click rather than on 保存
 *
 * The rest of the wall behaves this way already - 置顶 and 隐藏 take effect on the
 * menu row, and 别名 commits on blur. A tag editor with a 保存 button would have
 * two ways to lose an edit that the rest of this app has removed: closing with Esc
 * (which `DialogShell` handles and which must not discard), and opening the next
 * card before committing the last. Writing through `setRepo` on every add/remove
 * means there is nothing left to lose.
 *
 * ## The draft is local, the store is not the editor
 *
 * `tags` mirrors what is committed, so the row list and the counter cannot drift
 * from the wall. Every mutation goes through `addRepoTag` / `removeRepoTag`, which
 * are the same pure functions the batch verb and the tests use - the cap, the
 * dedupe and the trimming are decided once, and this file cannot talk itself past
 * them by writing the store directly.
 */
export function RepoTagsDialog({
  card,
  state,
  suggestions,
  onClose,
}: {
  /** The repository being tagged, named the way the wall names it. */
  card: { slug: string; repo: string; owner: string };
  state: RepoState | undefined;
  /** Tags already used elsewhere on this wall, offered so one person's `后端` is not another's `back-end`. */
  suggestions: string[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const setRepo = useWall((s) => s.setRepo);
  const [draft, setDraft] = useState("");
  const tags = useMemo(() => state?.tags ?? [], [state?.tags]);

  const commit = (next: string[] | null) => setRepo(card.slug, { tags: next ?? undefined });

  const submitDraft = () => {
    const tag = sanitiseTag(draft);
    if (!tag) return;
    // Refuse in place rather than silently dropping: at the cap `addRepoTag` hands
    // back the same list, and a draft box that empties itself would read as "that
    // tag was saved" when nothing happened.
    if (!hasRepoTag(tags, tag) && tags.length >= REPO_TAG_LIMIT) return;
    commit(addRepoTag(tags, tag));
    setDraft("");
  };

  const pending = sanitiseTag(draft);
  const atLimit = tags.length >= REPO_TAG_LIMIT;
  const offered = suggestions.filter((tag) => !hasRepoTag(tags, tag)).slice(0, 12);

  return (
    <DialogShell
      title={t("tags.title")}
      subtitle={`${card.owner}/${card.repo}`}
      onClose={onClose}
      width="md"
      regId="repo-tags-dialog"
    >
      <div className="flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // The IME rule every Enter-committing field in this app follows:
            // accepting a pinyin candidate is not "add this tag".
            if (isCommitEnter(e)) submitDraft();
          }}
          placeholder={t("tags.placeholder")}
          aria-label={t("tags.ariaNew")}
          maxLength={REPO_TAG_LENGTH_LIMIT}
          spellCheck={false}
          className="min-w-0 flex-1 skin-ctl border border-input bg-background px-2 py-1 text-caption
                     outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
        />
        <button
          type="button"
          onClick={submitDraft}
          disabled={!pending || (atLimit && !hasRepoTag(tags, pending))}
          className="skin-ctl flex shrink-0 items-center gap-1 border border-border px-2.5 py-1 text-caption transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("tags.add")}
        </button>
      </div>

      <p className="mt-1.5 text-caption text-muted-foreground">
        {tags.length} / {REPO_TAG_LIMIT}
        {atLimit && t("tags.atLimit")}
      </p>

      <section className="mt-3">
        <h3 className="skin-label mb-1.5 text-caption text-muted-foreground">
          {t("tags.currentTitle")}
        </h3>
        {tags.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-weak px-2.5 py-2 text-caption text-muted-foreground">
            {t("tags.empty")}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  onClick={() => commit(removeRepoTag(tags, tag))}
                  aria-label={t("tags.removeAria", { tag })}
                  title={t("tags.removeTitle")}
                  className={cn(
                    "skin-ctl flex items-center gap-1 border px-2 py-0.5 text-caption transition-colors",
                    "border-border-weak text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {tag}
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {offered.length > 0 && (
        <section className="mt-4">
          <h3 className="skin-label mb-1.5 text-caption text-muted-foreground">
            {t("tags.existingTitle")}
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {offered.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  onClick={() => commit(addRepoTag(tags, tag))}
                  disabled={atLimit}
                  aria-label={t("tags.addAria", { tag })}
                  className={cn(
                    "skin-ctl flex items-center gap-1 border px-2 py-0.5 text-caption transition-colors",
                    "border-dashed border-border-weak text-muted-foreground hover:bg-accent hover:text-foreground",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                  )}
                >
                  <Tags className="h-3 w-3" />
                  {tag}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </DialogShell>
  );
}
