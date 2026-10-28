/**
 * Settings catalog search (r25-N1).
 *
 * Pure ranking so the behaviour is testable without React: the view supplies
 * localized labels and a few aliases, this module decides which sections match
 * and in what order. Scores are ordered by match quality, then by catalog
 * position so equal matches keep the order the user already knows.
 */
export type SettingsSearchEntry = {
  id: string;
  label: string;
  keywords?: readonly string[];
};

export type SettingsSearchHit = {
  id: string;
  score: number;
};

const norm = (s: string) => s.trim().toLowerCase();

export function searchSettings(
  entries: readonly SettingsSearchEntry[],
  query: string,
): SettingsSearchHit[] {
  const q = norm(query);
  if (!q) return [];
  const hits: SettingsSearchHit[] = [];
  entries.forEach((entry, index) => {
    const label = norm(entry.label);
    const id = norm(entry.id);
    let rank: number | null = null;
    if (label === q || id === q) rank = 0;
    else if (label.startsWith(q)) rank = 1;
    else if (label.includes(q)) rank = 2;
    else if (id.includes(q)) rank = 3;
    else if (entry.keywords?.some((k) => norm(k).includes(q))) rank = 4;
    if (rank !== null) hits.push({ id: entry.id, score: rank * 1000 + index });
  });
  return hits.sort((a, b) => a.score - b.score);
}
