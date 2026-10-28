/**
 * 项目存储概览的纯聚合（r23-N1）。
 *
 * `repo_metadata` 已经为墙上的每个仓库给出递归体积与 `hasCache`，`useMeta` 把它们
 * 按 slug 存着。这个模块只做「把已有事实合成四个数」——不重新扫盘、不发明大小。
 * 未知体积（0）不计入总量，但单独计数，避免把「没量到」画成「0 B」。
 */
export type StorageInput = {
  slug: string;
  sizeBytes: number;
  hasCache: boolean;
};

export type StorageRow = StorageInput & { name: string };

export type StorageOverview = {
  repoCount: number;
  knownCount: number;
  unknownCount: number;
  totalBytes: number;
  cacheRepos: number;
  top: StorageRow[];
};

/** slug → 人类可读名字；调用方可以给 owner/repo 或目录名。 */
export function buildStorageOverview(
  items: readonly StorageInput[],
  nameOf: (slug: string) => string,
  topN = 5,
): StorageOverview {
  const rows: StorageRow[] = [];
  let totalBytes = 0;
  let knownCount = 0;
  let cacheRepos = 0;
  for (const item of items) {
    const size = Number.isFinite(item.sizeBytes) && item.sizeBytes > 0 ? Math.floor(item.sizeBytes) : 0;
    if (size > 0) {
      totalBytes += size;
      knownCount += 1;
    }
    if (item.hasCache) cacheRepos += 1;
    rows.push({ ...item, sizeBytes: size, name: nameOf(item.slug) });
  }
  rows.sort((a, b) => b.sizeBytes - a.sizeBytes || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return {
    repoCount: items.length,
    knownCount,
    unknownCount: items.length - knownCount,
    totalBytes,
    cacheRepos,
    top: rows.slice(0, Math.max(0, Math.floor(topN))),
  };
}
