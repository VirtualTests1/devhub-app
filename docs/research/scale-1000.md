# 大规模集合：墙派生与仓库扫描实测（r33-D8）

> **已被 [scale-1000-r34](scale-1000-r34.md) 部分取代（2026-10-30）。** 本文的 50 仓库
> 对照与“索引把 50 次解析从 1.6 s 降到 5 ms”仍然有效；但 `--scan-check` 的 O(n²) 阶段
> 已在 r34 改为固定 20 个采样，1,000 仓库的读数以 r34 文档为准。本文“没有修改
> `--scan-check`”是 r33 当时的边界，不是当前状态。

日期：2026-10-30。环境：Windows 10/11，Node `22.19.0`（`node --version`），
debug 构建 `src-tauri/target/debug/devhub-app.exe`，.checkout 与夹具都在 D:
（本机已知 fsync 慢的 JMicron 桥接盘）。仓库存量 13 个，所以两组实验都用合成输入，
不是对真实用户集合的推断。

## 1. 墙派生在 2 000 张卡上的成本

对象：`src/lib/wall-derive.ts` 的 `filterWallCards` / `tierSortCards` /
`groupCardsByOwner`。脚本：`scripts/wall-scale-bench.mjs`（纯函数，无渲染器）。

```powershell
node --experimental-strip-types --import ./tests/helpers/register.mjs `
  scripts/wall-scale-bench.mjs --cards 2000 --runs 30
```

实测（median / p95，30 次）：

| 阶段 | median | p95 |
|---|---:|---:|
| filter（query + tag） | 2.30 ms | 3.89 ms |
| tierSort:name | 0.45 ms | 0.63 ms |
| tierSort:recent | 0.56 ms | 0.94 ms |
| tierSort:frequent（优化前） | 4.35 ms | 5.07 ms |
| tierSort:frequent（优化后） | **1.06 ms** | 1.46 ms |
| tierSort:size | 1.36 ms | 1.68 ms |
| tierSort:stars | 2.21 ms | 2.52 ms |
| tierSort:desc | 1.61 ms | 2.19 ms |
| tierSort:owner | 2.43 ms | 2.94 ms |
| tierSort:cache | 1.43 ms | 2.54 ms |
| group by owner | 0.12 ms | 0.24 ms |
| full pipeline（name 之外的一次完整走） | 2.87–5.03 ms | 3.26–7.67 ms |

结论与改动：`frequent` 是唯一在比较器里重复做衰减数学的档位（每次比较调用两次
`usageScore`）。改成每张卡先算一次分数（`Map<T, number>`），排序语义不变，
2 000 张卡从 4.35 ms 降到 1.06 ms（约 4.1×）。其余档位都在 3 ms 以内，没有值得
改动的热点；`full pipeline` 的区间波动来自机器负载，不与单阶段相加。

**适用边界**：这是纯函数的 CPU 成本，不含 React 渲染与 DOM。项目墙另有
`WALL_WINDOW_STEP = 48` 的窗口化（`src/lib/wall-window.ts`），所以 2 000 张卡
实际不会一次挂载 2 000 个 `RepoTile`；本实验证明的是“每次筛选/排序的派生”不会
先成为瓶颈，而不是“2 000 张卡可以同屏”。

## 2. 仓库扫描与 slug 解析在 50 个仓库上的成本

夹具：`scripts/scale-fixture.mjs` 生成 `<root>/<owner>/<repo>/.git` +
`.devhub.json`，与 walker 的实际布局一致（不含网络、不含真实仓库内容）。

```powershell
node scripts/scale-fixture.mjs --root .pack/scale-fixture --count 50
.\src-tauri\target\debug\devhub-app.exe --scan-check 3 `
  .pack\scale-fixture
$env:DEVHUB_NO_INDEX = "1"; .\src-tauri\target\debug\devhub-app.exe --scan-check 2 `
  .pack\scale-fixture
```

实测（50 个仓库、2 个 owner）：

| 阶段 | 无索引 | 有索引 |
|---|---:|---:|
| walk（`collect_repos_counted`） | 33 ms（worst） | — |
| list（walk + identity） | 32 ms（worst） | 85 ms 冷启动（含写 `.devhub-index.json` + fsync） |
| 50 次 slug 解析 | **1 584 ms** | **5 ms** |
| 同一索引再次读取 | — | 0 ms（memory） |
| 失效后一次重校验 | — | 9 ms |

`DEVHUB_NO_INDEX=1` 下索引路径退化为全扫描，数字与“无索引”一列一致（50 次解析
1 626 ms），说明两组读数来自同一条代码路径，而不是两次不同的采样。

**为什么没有做到 1 000 个仓库**：`--scan-check` 的“解析每个 slug”阶段是
**O(n²)** 的设计——每个 slug 都调用一次 `find_repo_by_slug`，而它每次重走整个
容器。50 个仓库已经是 1.6 s；1 000 个仓库按同一比例放大到约 10 分钟量级，实测
运行超过 10 分钟仍未结束，被中止。这条基线本身就是索引存在的理由：生产路径
（`repo_index::find`）在同一夹具上是 5 ms/50 次，而不是 1.6 s/50 次。本实验
没有修改 `--scan-check`，因为它是**前后对照**的诊断工具，删掉慢的那一半会让
“索引到底省了什么”变成一句无法复现的断言。

## 3. 结论与遗留

- 墙派生在 2 000 张卡上 < 5 ms（`frequent` 优化后 < 2 ms），不需要 worker 或虚拟化重写；
  窗口化 48 张的上限仍是 DOM 成本的主要保护。
- 仓库索引把 50 次 slug 解析从 1.6 s 降到 5 ms；冷启动写索引约 85 ms（D: 的 fsync 成本，
  在快盘上会更低）。1 000 个仓库的 `--scan-check` 基线不可用，原因已记录，不作为产品
  性能结论。
- 未测：真实 1 000 个仓库的 `list_repositories` 完整路径（需要 1 000 份真实克隆或
  更大的合成夹具；上表只覆盖 50 个）、WebView2 渲染成本、跨卷/网络盘。
