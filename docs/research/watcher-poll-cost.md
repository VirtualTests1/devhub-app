# 700 ms 轮询的真实成本（r32-O2）

日期：2026-10-29。对象：`src-tauri/src/fs_watch.rs` 的 `signature`/`scan`。

## 1. 测什么

一次轮询不是“看一眼根目录”：它 `read_dir` 每个被监听仓库，并对每个直接子项取
一次 `metadata`（用于 root mtime + 最新子项 mtime）。成本随“仓库数 × 直接子项数”
增长，与仓库内容大小无关。

## 2. 可复现实验

```powershell
cd src-tauri
cargo test --lib bench_scan_cost_at_100_roots -- --ignored --nocapture
```

临时目录建 100 个根目录，每个 20 个文件（共 2,000 个直接子项），然后测
`set_watched` 与 5 次 `scan`。

## 3. 实测（本机 D: 卷，2026-10-29）

| 项目 | 结果 |
|---|---:|
| `set_watched(100 roots)`（含首次签名） | 357 ms |
| `scan(100 roots, 20 children)` | **325 ms / pass** |

按 700 ms 周期计算，这一项约占单核 46% 的墙钟时间；改为原生 watcher 全覆盖时的
5 s 兜底后约 6.5%。`set_watched` 的 357 ms 是一次性的，不计入周期。

## 4. 解读与边界

- 这是**合成**的 100 根/2,000 子项规模，不是用户真实墙；真实墙通常更小，但
  `node_modules` 等目录会把直接子项数抬高。
- 数字包含 D: 卷的元数据访问延迟（本机 D: 是慢速桥接盘）；C:/NVMe 上会更低。
- 没有测量真实应用进程的 CPU 占用；结论是“这次扫描本身要多久”，不是“整机省了
  多少电”。
- 原生 watcher 全覆盖时才退避到 5 s；任一被监听根没有 watcher（权限、网络盘、
  句柄失败）就恢复 700 ms，漏事件的检测延迟不会被悄悄放大。
- 没有 GUI 真机验证；改变的是后台线程的睡眠间隔与覆盖率计数。
