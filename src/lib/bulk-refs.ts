/**
 * Multi-line repository import, as a pure parser (r24-N2-1).
 *
 * The add page could take exactly one ref at a time; the download queue could
 * already run several. Bulk paste closes that gap without inventing a second URL
 * rule: `parseGithubRepoUrl` stays the single source for "what a GitHub ref is",
 * and a bare `owner/repo` is accepted only when it is exactly two safe segments
 * (the same shape the deep-link handler accepts).
 *
 * Limits are part of the contract, not a UI afterthought: 20 refs per paste keeps
 * one keystroke from starting a hundred git processes, and every dropped line is
 * returned with its reason so the field can show what will NOT be queued.
 */
import { parseGithubRepoUrl } from "./utils";

/** One paste may queue at most this many repositories. */
export const BULK_MAX = 20;

/** GitHub owners that are routes, not people/organisations. */
const RESERVED_OWNERS = new Set([
  "settings",
  "notifications",
  "explore",
  "topics",
  "collections",
  "events",
  "sponsors",
  "orgs",
  "users",
  "features",
  "marketplace",
  "pricing",
  "about",
  "login",
  "join",
  "new",
  "organizations",
]);

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * `owner/repo`, or `null` for anything this app should not clone.
 *
 * The SSH form is accepted because it is what `git clone` examples copy from:
 * `git@github.com:owner/repo.git`. It is rewritten to the HTTPS identity rather
 * than forwarded as a URL — the downloader records `owner/repo` and applies the
 * configured route itself.
 */
export function normalizeBulkRef(raw: string): string | null {
  const text = raw
    .trim()
    .replace(/^["'<]+|["'>]+$/g, "")
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^["'<]+|["'>]+$/g, "")
    .trim();
  if (!text) return null;

  const viaUrl = parseGithubRepoUrl(text);
  if (viaUrl) return viaUrl;

  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(text);
  if (ssh) return checked(ssh[1], ssh[2]);

  const parts = text.split("/");
  if (parts.length !== 2) return null;
  return checked(parts[0], parts[1]);
}

function checked(owner: string | undefined, repo: string | undefined): string | null {
  if (!owner || !repo) return null;
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  return `${owner}/${repo}`;
}

export type BulkParse = {
  /** Unique refs, first spelling wins, capped at `max`. */
  accepted: string[];
  /** Normalised refs that appeared again after their first occurrence. */
  duplicates: string[];
  /** Lines that are not a repository, with their 1-based token number. */
  invalid: { at: number; text: string }[];
  /** Valid, unique refs past the cap — named so the UI can say how many. */
  overflow: number;
};

/**
 * Parse a pasted block. Newlines, commas and semicolons all separate entries:
 * a copied list is one-per-line, a copied sentence is comma-separated, and a
 * spreadsheet column is tab-separated.
 */
export function parseBulkRefs(text: string, max: number = BULK_MAX): BulkParse {
  const tokens = text.split(/\r?\n|[,;\t]+/);
  const accepted: string[] = [];
  const duplicates: string[] = [];
  const invalid: BulkParse["invalid"] = [];
  const seen = new Set<string>();
  let overflow = 0;
  let at = 0;
  for (const token of tokens) {
    const raw = token.trim();
    if (!raw) continue;
    at += 1;
    const ref = normalizeBulkRef(raw);
    if (ref === null) {
      invalid.push({ at, text: raw });
      continue;
    }
    const key = ref.toLowerCase();
    if (seen.has(key)) {
      const existing = duplicates.find((d) => d.toLowerCase() === key);
      if (!existing) duplicates.push(ref);
      continue;
    }
    seen.add(key);
    if (accepted.length >= max) {
      overflow += 1;
      continue;
    }
    accepted.push(ref);
  }
  return { accepted, duplicates, invalid, overflow };
}
