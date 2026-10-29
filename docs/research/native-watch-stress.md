# 原生目录监听的事件覆盖率压力实验（r32-R2）

日期：2026-10-29。对象：`src-tauri/src/native_watch.rs` 的 `ReadDirectoryChangesW`
读取循环（`bWatchSubtree = TRUE`，64 KB 缓冲），以及它下游的 `DebouncedBatch`。

## 1. 问题

`fs_watch.rs` 的 700 ms 轮询只能看到仓库根目录的条目数/最新 mtime；子目录里的写入
依赖原生 watcher。若 `ReadDirectoryChangesW` 在密集写入下丢名字或溢出缓冲，应用会
“以为仓库没变”。这个实验测量真实写入批次下的**唯一文件名覆盖**，不是只看“有没有
事件”。

## 2. 方法

测试（默认 `#[ignore]`，在 Windows 上运行）：

```powershell
cd src-tauri
cargo test --lib bench_write_burst_coverage -- --ignored --nocapture
```

临时根目录下建 10 个子目录，启动 watcher 后写入 500 个文件（`d{0..9}/f0000.txt`
…），用 800 ms 空闲超时排空通道；统计唯一路径名、文件名、批次和错误。

## 3. 实测（同一台机器，两次）

| 轮次 | 写入 500 文件耗时 | 唯一名字 | 其中文件名 | 通道批次 | 错误 | 排空耗时 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 2,221 ms | 510 | **500/500** | 1,490 | 0 | 3,025 ms |
| 2 | 680 ms | 510 | **500/500** | 1,490 | 0 | 1,486 ms |

510 = 500 个文件 + 10 个目录（目录名也会作为事件出现）。两次都没有丢文件名。

## 4. 解读与边界

- 一次写入会产生多条通知（文件名/大小/最后写入时间各一条），下游 `DebouncedBatch`
  按仓库 slug 合并成一次刷新；批次多不等于 UI 会刷新多次。
- 64 KB 缓冲在 500 文件规模没有溢出。**没有测 1 万/10 万文件**的爆发；如果缓冲溢出，
  Windows 会以 `ERROR_NOTIFY_ENUM_DIR` 结束当前读取，读取循环把它作为 `Err` 交给上层，
  轮询兜底仍然存在（原生全覆盖时 5 s 一次，有根未覆盖时 700 ms 一次，见 r32-O2）。
- 实验只覆盖 NTFS 本地卷；网络盘/被过滤驱动拦截的目录没有测。
- 没有真机 GUI 验证；结论来自 watcher 通道本身。

## 5. 来源

- `ReadDirectoryChangesW`：
  <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw>
- 本机 `cargo test` 输出（2026-10-29，§3）。
