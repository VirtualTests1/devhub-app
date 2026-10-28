/**
 * 记录页批量选择的集合算术：表头「已选 N」、全选开关、以及筛选一变就要丢掉的 id。
 *
 * Lives in a module instead of inline in `RecordsView` for the same reason
 * `filter-words.ts` does — the state it must never produce is testable. The bug
 * this exists to fix: the header used to compare `picked.size === filtered.length`,
 * i.e. a *count* against a *list*, and `picked` was only cleared on 退出选择 or
 * after a delete. Select everything under one 类别, switch chip: the header kept
 * saying 已选 N and 取消全选 while no visible row was checked, and 删除所选 went
 * on to delete the ids that were no longer on screen.
 *
 * So the header answers from set membership over the ids *currently shown*
 * (`pickedCount` / `pickedIsAll`), and `prunePicked` drops the ids a filter
 * change took off screen — selection is a fact about the result set, not a fact
 * about the log file.
 */

/**
 * How many of the shown ids are picked — the 已选 N count.
 *
 * Picked ids outside `ids` are invisible work, not selection: they are not
 * counted here, and `prunePicked` drops them the moment the filter moves.
 */
export function pickedCount(picked: Set<string>, ids: readonly string[]): number {
  let n = 0;
  for (const id of ids) if (picked.has(id)) n += 1;
  return n;
}

/**
 * Whether every shown id is picked — the 取消全选 vs 全选 state.
 *
 * An empty result set is never "all": `0 === 0` used to render 取消全选 over a
 * list with nothing in it, a button whose press could only clear what was not
 * there.
 */
export function pickedIsAll(picked: Set<string>, ids: readonly string[]): boolean {
  return ids.length > 0 && pickedCount(picked, ids) === ids.length;
}

/**
 * Drops picked ids that are no longer in `ids`, keeping the rest.
 *
 * Returns the very same `Set` when nothing was dropped (a strict subset is
 * guaranteed, so equal size means equal members) — the effect that calls this
 * on every filter change then cannot cause a re-render by itself.
 */
export function prunePicked(picked: Set<string>, ids: readonly string[]): Set<string> {
  const keep = new Set(ids);
  const next = new Set<string>();
  for (const id of picked) if (keep.has(id)) next.add(id);
  return next.size === picked.size ? picked : next;
}
