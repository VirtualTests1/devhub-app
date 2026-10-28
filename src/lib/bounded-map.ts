/**
 * A `Promise.all` that cannot start more than N things at once.
 *
 * ## Why this exists
 *
 * `BatchBar` fans a per-repository command out over the selection with
 * `Promise.all`, which is exactly right for 批量停止 / 批量清缓存 / 批量删除: those
 * are local syscalls and file moves, and the backend serialises the destructive
 * ones itself. It is exactly wrong for 批量更新, because one 更新 is a `git pull`
 * subprocess reaching out to a remote (`downloader.rs:1953-1968`, spawned through
 * `spawn_blocking`), so an uncapped `Promise.all` over 全选 on a 40-repository wall
 * means 40 simultaneous git processes and 40 simultaneous TLS sessions to one
 * host — the same "one invoke per tile per wall load" storm this app has already
 * refused twice elsewhere (see `lib.rs:1266-1271` on why freshness is cached for
 * five minutes, and `ProjectsView.tsx:84-90` on why 有启动命令 is not a chip).
 *
 * ## What it guarantees
 *
 *   - at most `limit` workers in flight, ever;
 *   - results come back in **input order**, not completion order — the caller
 *     prints them as a named list, and a list that re-orders itself between two
 *     rows is unreadable;
 *   - the first rejection settles the whole call, like `Promise.all`. That is
 *     deliberate: a batch's per-item failure handling belongs to the caller
 *     (`BatchBar` catches per item and records `{ ok: false }`), and quietly
 *     turning a rejected worker into a hole in the array would make "12 成功"
 *     a claim nobody can check.
 *
 * Workers are started as slots free, so a slow item never blocks the ones behind
 * it that were going to start anyway.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (!items.length) return results;
  // Clamp: 0, negative, NaN and "larger than the list" all mean "as much of the
  // list as there is", never "run nothing" and never "run unbounded".
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let slot = 0; slot < width; slot += 1) {
    runners.push(
      (async () => {
        while (true) {
          const i = next;
          next += 1;
          if (i >= items.length) return;
          const item = items[i];
          if (item === undefined) return;
          results[i] = await worker(item, i);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}
