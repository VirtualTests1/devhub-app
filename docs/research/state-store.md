# 后端状态存储：JSON 全量文件 vs SQLite（r31-R4）

日期：2026-10-29。环境：Windows 10/11，Node `v22.19.0`，临时目录在 D:（本机已知
fsync 慢的 JMicron 桥接盘）。实验使用 Node 内置 `node:sqlite`（experimental）以避免
新增依赖；**这不是生产选型，也不是 node:sqlite 的采用决定**。

## 1. 问题

后端的设置、星标、新鲜度、活动记录都是“读整个文件 → 改 → 原子替换”的 JSON。
“JSON 不会扩展”是一个常见断言，但没有在本项目的记录规模/磁盘上量过。反过来，SQLite
会带来依赖、schema 迁移、备份/回滚与并发写入策略；只有数据证明它值得才应该引入。

## 2. 方法

`scripts/state-store-bench.mjs` 对同一批记录比较：

- **JSON**：`JSON.stringify` → `write()` → `fsync()`（与应用 `write_atomic` 的
  `sync_all` 对应），读为 `readFileSync` + `JSON.parse`，单行更新为重写整个文件。
- **SQLite**：`DatabaseSync`，`PRAGMA synchronous = FULL`，一个事务内 prepared
  INSERT，全表 `SELECT`，单行 `UPDATE`。
- 每个规模重复 3 次取中位数；临时文件/数据库在结束时删除。

记录形状接近墙/活动数据（slug、别名、备注、标签、时间戳、布尔），不是单个整数。

## 3. 实测结果

| 记录数 | JSON 写 | JSON 读 | JSON 改一行 | JSON 字节 | SQLite 写 | SQLite 读 | SQLite 改一行 | SQLite 字节 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 200 | 99.1 ms | 1.0 ms | 99.8 ms | 30,509 | 311.4 ms | 0.9 ms | 332.9 ms | 28,672 |
| 2,000 | 92.2 ms | 5.7 ms | 117.8 ms | 310,246 | 394.3 ms | 5.0 ms | 244.8 ms | 208,896 |
| 10,000 | 137.1 ms | 24.8 ms | 188.4 ms | 1,565,489 | 498.0 ms | 23.1 ms | 292.6 ms | 991,232 |
| 100,000 | 749.0 ms | 249.8 ms | 647.4 ms | 15,920,381 | 1,825.7 ms | 331.2 ms | 229.2 ms | 10,264,576 |

（中位数；`--quick` 的前两行与单规模运行分别测得，见脚本 `--sizes`。）

## 4. 解读

- 在这块盘上，**SQLite 的初始写入/全量读取更慢**：默认 `synchronous=FULL` 的提交
  需要 fsync，事务成本不随记录数线性下降；JSON 只付一次文件 fsync。
- SQLite 在 100k 时文件小约 35%，且**单行更新**开始明显占优（229 ms vs 647 ms），
  但它仍是“一次 UPDATE + 一次提交 fsync”，在更快的盘上比例会变。
- JSON 在 100k 记录、约 16 MB 时仍能在 1 秒内完成全量写/读；当前真实存储远小于此：
  设置是几十个字段，活动记录有 cap，新鲜度缓存 cap 512，星标是每个仓库一行。
- 因此没有证据支持为当前规模引入 SQLite。引入它会把一个“可读、可手工恢复、原子替换”
  的格式换成依赖 + schema 迁移 + WAL/journal 文件 + 备份策略。

## 5. 决策与门槛

**继续使用 JSON 原子文件。** 只有当任一真实存储持续超过约 10,000 条记录且以单行更新
为主，或多个进程/线程需要并发写同一逻辑表时，才重新评估。届时：

- Rust 侧使用成熟 SQLite 绑定（评估许可证、维护状态、目标平台），不是本脚本的
  Node 内置模块；
- 明确 `journal_mode`/`synchronous` 的耐久性取舍，并提供导出/备份与 schema 迁移；
- 保留 JSON 导出作为人工恢复通道；
- 在真实数据上重复本基准，而不是把本文的数字当作 SQLite 在所有磁盘上的结论。

## 6. 未验证/限制

- Node 内置 SQLite 是 experimental，和 Rust SQLite 绑定的行为/性能不完全相同；
- 只测了本机 D: 卷；C:/E: 的 fsync 特性不同，结果会变；
- 没有测并发写、崩溃恢复、WAL 模式或索引查询；这些是引入 SQLite 后必须单独验证的面；
- 没有把任何 store 迁到 SQLite，也没有新增依赖。

## 7. 复现

```bash
node scripts/state-store-bench.mjs --quick
node scripts/state-store-bench.mjs --sizes 10000,100000 --json
```

## 8. 来源

- SQLite `PRAGMA synchronous`：<https://www.sqlite.org/pragma.html#pragma_synchronous>
- SQLite WAL：<https://www.sqlite.org/wal.html>
- Node `node:sqlite`：<https://nodejs.org/api/sqlite.html>
- 本机 `node --version` 与脚本输出（2026-10-29，见 §3）。
