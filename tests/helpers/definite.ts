/**
 * r19-o2-4：`noUncheckedIndexedAccess` 之下的「这一项一定在」显式断言。
 *
 * 没有这个 helper 之前，测试里的 `items[0]` 是隐式信任——缺项时红在
 * `TypeError: Cannot read properties of undefined`，读起来像被测代码的 bug，
 *其实是测试自己的假设错了。开了 flag 之后 TS 要求把这件事写出来，选择是：
 * `!`（禁项，ESCAPE_HATCH_BASELINE = {} 的纪律）或者一个会报人话的断言。
 *
 * 语义与从前完全一致：缺项照样让测试失败，只是失败信息指明缺的是哪一项。
 * 通过路径零行为变化（值已经在时直接返回）。
 */

/** 数组按索引取「一定存在」的元素；缺项时抛出指明索引与长度的错误。 */
export function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`expected index ${index} to be present (length ${items.length})`);
  }
  return value;
}

/** 记录按键取「一定存在」的值；缺项时抛出指明键名的错误。 */
export function atKey<T>(record: Record<string, T>, key: string): T {
  const value = record[key];
  if (value === undefined) {
    throw new Error(`expected key "${key}" to be present`);
  }
  return value;
}
