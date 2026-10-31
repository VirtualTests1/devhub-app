/**
 * User-defined launch command templates.
 *
 * ## What this is and is not
 *
 * `effectiveSteps.STEP_TEMPLATES` ships four built-in presets (Node npm/pnpm,
 * Python, Docker Compose). They cover the common case but cannot anticipate a
 * team's internal tooling: a repo that runs `pnpm install && pnpm db:migrate &&
 * pnpm dev` has no built-in template, and typing those three steps into every
 * new clone is the "why does this not remember" friction this module removes.
 *
 * So: built-ins are read-only; user templates are read-write and live in
 * `localStorage` next to the other webview-side state. A template is a labelled
 * list of `LaunchStep`s; applying one replaces the editor's current steps, and
 * saving the editor as a template captures what is on screen.
 *
 * ## Storage shape
 *
 * One key, one JSON array. `null`/missing means "no user templates yet" rather
 * than `[]` so the first-run state is distinguishable from "the user deleted
 * everything". The array order is the display order (most recently saved last
 * is not enforced — the user may reorder later; for now it is creation order).
 *
 * ## Sanitisation
 *
 * Templates cross the localStorage boundary, which is untrusted on reload. The
 * reader does structural validation (array of objects with the four fields) and
 * drops anything that does not match — a corrupted entry must not crash the
 * editor. Empty commands are kept on read (the built-ins never have them, but
 * a user might save a WIP) and the editor's own save gate rejects empty
 * commands at launch time.
 */
import type { LaunchStep } from "../types";
import { persistJson } from "./persist";

const STORAGE_KEY = "devhub.launch.templates.v1";

export type UserTemplate = {
  id: string;
  label: string;
  steps: LaunchStep[];
};

/** Read every stored template, structurally validated. */
export function loadUserTemplates(): UserTemplate[] {
  if (typeof localStorage === "undefined") return [];
  let raw: string | null = null;
  // The read itself can throw. `JSON.parse` is guarded below because a bad *value*
  // is the failure people expect; a bad *storage* — a WebView2 profile whose Leveldb
  // is wedged, or a policy that denies the origin — throws out of `getItem` before
  // any value exists, and every other store in this app already wraps its read
  // (see the try/catch at `store/failures.ts`, `store/searches.ts`, `store/landing.ts`).
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: UserTemplate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || typeof t.label !== "string") continue;
    if (!Array.isArray(t.steps)) continue;
    const steps: LaunchStep[] = [];
    for (const s of t.steps) {
      if (!s || typeof s !== "object") continue;
      const step = s as Record<string, unknown>;
      if (typeof step.command !== "string") continue;
      steps.push({
        name: typeof step.name === "string" ? step.name : "",
        command: step.command,
        cwd: typeof step.cwd === "string" ? step.cwd : "",
        parallel: step.parallel === true,
      });
    }
    if (steps.length === 0) continue;
    out.push({ id: t.id, label: t.label, steps });
  }
  return out;
}

function persist(templates: UserTemplate[]): boolean {
  // A refused write must not take the editor down: the list the user is looking
  // at is still correct in memory. It must not claim the disk has it either —
  // the caller now gets the outcome and can say "only for this session".
  return persistJson(STORAGE_KEY, templates).ok;
}

function nextId(existing: UserTemplate[]): string {
  let n = 1;
  const used = new Set(existing.map((t) => t.id));
  while (used.has(`tpl-${n}`)) n += 1;
  return `tpl-${n}`;
}

/** A mutation plus whether the disk copy actually changed. */
export type TemplateWrite<T> = { value: T; persisted: boolean };

/** Save `steps` as a new template. */
export function saveTemplate(label: string, steps: LaunchStep[]): TemplateWrite<UserTemplate> {
  const trimmed = label.trim();
  const name = trimmed.length > 0 ? trimmed.slice(0, 60) : `模板 ${new Date().toLocaleDateString()}`;
  const existing = loadUserTemplates();
  const created: UserTemplate = { id: nextId(existing), label: name, steps };
  return { value: created, persisted: persist([...existing, created]) };
}

/** Replace a template's steps in place. `value` is false if the id was not found. */
export function updateTemplate(id: string, steps: LaunchStep[]): TemplateWrite<boolean> {
  const existing = loadUserTemplates();
  const idx = existing.findIndex((t) => t.id === id);
  if (idx === -1) return { value: false, persisted: false };
  const current = existing[idx];
  if (!current) return { value: false, persisted: false };
  existing[idx] = { ...current, steps };
  return { value: true, persisted: persist(existing) };
}

/** Delete a template by id. `value` is false if the id was not found. */
export function deleteTemplate(id: string): TemplateWrite<boolean> {
  const existing = loadUserTemplates();
  const next = existing.filter((t) => t.id !== id);
  if (next.length === existing.length) return { value: false, persisted: false };
  return { value: true, persisted: persist(next) };
}
