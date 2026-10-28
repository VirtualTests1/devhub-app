//! Tantivy 本地全文索引调研（R1）。
//!
//! ## 选型依据（2026-10-19 实测复核，读数与复现命令见 `docs/tantivy-bench.md`）
//!
//! 下面这张表原来是**没有出处的推演**；r21-R3 用本仓真实语料（223 文件 / 80,442 行 /
//! 3,775,173 B，FNV-1a64 指纹 `707605ebc118d750`，与 `repo_grep` 同一套扫描逻辑）重跑了一遍。
//! 三行被证伪，已在表内改为实测值；「Linux 内核 1–2GB」一说本机无该量级语料，标为未核实。
//!
//! | 方案 | 查询时延（本机实测） | 维护状态 | 依赖量 | 说明 |
//! |------|------------------------|----------|--------|------|
//! | Tantivy | P50 **9.4µs** / P95 15.1µs（原称 <10ms） | 活跃（v0.22.1） | 子树 **99 crate**（原称 ~15，已证伪） | 需**常驻索引**：构建 3.58s、体积 语料的 42.62% |
//! | regex+walkdir | 冷 **77.4ms** / 热 **9.08ms**（原称 ~1-5s，已证伪） | 标准库 | 已在 N2 | 立即可用，无需失效策略 |
//! | Ripgrep（整进程） | P50 **137–173ms**（原称 <50ms，原表未写口径） | 独立 CLI | 调用外部二进制 | 含进程启动；未拆分纯搜索耗时 |
//! | SQLite FTS5 | P50 **300–547µs**（原称 <10ms，已证实） | 稳定 | sqlite 绑定 | 行级 doc、整词命中；库体积 语料的 196% |
//!
//! **选型：Tantivy 依赖保持骨架，本轮不接入**（证据与重开条件见 `docs/tantivy-bench.md` §6）：
//! 质量 0.991 与已上线的渲染侧 BM25（0.9907）打平，而内容搜索今天由 `repo_grep` 承担（热扫 9ms）；
//! 接入的真实代价是 99 个 crate 子树 + **尚无设计的索引失效策略**——没有失效策略的索引会给出
//! 比 grep 更快但可能过期的答案。
//! `tantivy_status` 继续作为调研占位命令，`repo_grep` 是立即可用的全文搜索实现。
//!
//! ## 限制
//!
//! 索引目录体积实测为语料的 **42.62%**（原写「每个文件约 15% 膨胀」，已证伪）。
//! 「10 个大型仓库（Linux 内核 ~100万文件 × 10MB）的索引在 1-2GB 量级」**本机未核实**——
//! 没有该量级语料，也没有实跑；不要当已知事实引用。
//!
//! ## 后续迭代
//!
//! - `repo_tantivy_index(root)` 为单个仓库建索引（增量更新）——**前提是先设计 `fs-watch` 侧的索引失效**
//! - `repo_tantivy_search(index, pattern)` 跨索引搜索
//! - 前端搜索 UI：与本表无关——`repo_grep` 的搜索面板已在 r21-N1 上线

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct TantivyBenchmark {
    pub note: String,
}

/// 占位命令——当前 Tantivy 还没接入，直接返回「不可用」。
/// 后续接入后，这个命令会变成「在指定目录建索引 + 搜索」的入口。
#[tauri::command]
pub fn tantivy_status() -> TantivyBenchmark {
    TantivyBenchmark {
        note: "Tantivy 索引方案已在 Cargo.toml 接依赖（tantivy = \"0.22\"），但核心索引/查询逻辑还没接入。N2 的 repo_grep 继续作为立即可用的全文搜索实现。".to_string(),
    }
}

#[cfg(test)]
mod bench {
    //! R3-1 可复现基准：核实本模块头选型表里的性能数字（研究探索，2026-10-19）。
    //!
    //! 口径（全部落在输出 JSON 里，stdout 只是给人看的同一份数）：
    //!
    //! - **语料** = 本仓真实文件：`src/` + `docs/` + `src-tauri/src/` 下、候选过滤
    //!   链与生产 `repo_grep` 完全同款（复用 `searchgrep.rs` 的
    //!   `IGNORE_DIRS` / `INCLUDE_EXTS`）。行数如实统计——**不凑 10 万行**，选型表
    //!   「10万行索引」的未注明项（doc 粒度）也写进 JSON 的 `index.docGranularity`。
    //! - **计时** 一律 `std::time::Instant`（任务约束：不新增 Cargo 依赖、不用 criterion）。
    //!   每个查询模式先 warmup 再重复取样，报**最近秩**中位数（P50）与 P95。
    //! - **内存** 用本文件里的计数分配器量堆 live/peak 字节（不是进程 RSS，不含
    //!   mmap 段文件映射——这条也写进 JSON `memory.unit`）。
    //! - **profile 口径**：输出里如实打印 `cfg!(debug_assertions)` 推出来的
    //!   release/debug——同一份数字只在其口径下可引用。
    //!
    //! 复现（release 口径；先 dot-source **主检出**的 env.ps1 拿 MSVC/sccache 环境）：
    //!
    //! ```powershell
    //! . .\env.ps1
    //! Set-Location src-tauri
    //! cargo test --release --lib tantivy_idx::bench -- --ignored --nocapture --test-threads=1
    //! ```
    //!
    //! 产物：stdout 人类可读表格 + `.pack/tantivy-bench/result.json`（机器可读，
    //! 含 command/环境/语料指纹/口径）。索引写在 `.pack/tantivy-bench/index/`。
    //! 清理：`Remove-Item -Recurse .pack\tantivy-bench`（`.pack/` 本就在 .gitignore，
    //! 两样东西同一个目录，一条命令清干净）。

    use std::alloc::{GlobalAlloc, Layout, System};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use regex::Regex;
    use tantivy::collector::{Count, TopDocs};
    use tantivy::query::{BoostQuery, BooleanQuery, Occur, Query, TermQuery};
    use tantivy::schema::{Field, IndexRecordOption, OwnedValue, Schema, STORED, STRING, TEXT};
    use tantivy::{doc, Index, IndexWriter, Searcher, TantivyDocument, Term};
    use walkdir::WalkDir;

    use crate::searchgrep::{IGNORE_DIRS, INCLUDE_EXTS};

    // -----------------------------------------------------------------------
    // 口径常量（改这里就要重跑并更新 docs/tantivy-bench.md）

    /// 语料三根（任务规定：`src/` + `docs/` + `src-tauri/src/`）。
    const CORPUS_ROOTS: &[&str] = &["src", "src-tauri/src"];
    /// 索引与结果 JSON 的家（相对仓库根）。`.pack/` 已在 .gitignore。
    const BENCH_DIR: &str = ".pack/tantivy-bench";
    const INDEX_SUBDIR: &str = "index";
    const RESULT_JSON: &str = "result.json";
    /// r3-2 质量产物（与离线对比工具的 --rust 默认值同路径）。
    const QUALITY_JSON: &str = "tantivy-quality.json";
    /// 两个 #[ignore] 基准共用的复现命令（主检出 env.ps1 + release + 单线程）。
    const REPRO_COMMAND: &str = ". .\\env.ps1; Set-Location src-tauri; cargo test --release --lib tantivy_idx::bench -- --ignored --nocapture --test-threads=1";
    /// tantivy writer 的内存预算（arena 上限，分线程；不是实际占用）。
    const WRITER_BUDGET: usize = 64 * 1024 * 1024;
    const RAM_WRITER_BUDGET: usize = 16 * 1000 * 1000;

    const TANTIVY_WARMUP: usize = 5;
    const TANTIVY_REPEATS: usize = 200;
    const COLD_WARMUP: usize = 2;
    const COLD_REPEATS: usize = 20;
    const WARM_WARMUP: usize = 3;
    const WARM_REPEATS: usize = 50;

    /// 查询模式：ASCII 词 + 中文词——`default` 分词按「字母数字连续段」切，中文能不能
    /// 命中由命中数直接暴露，不做预设。零命中对照**不在这个表里**：语料含本文件自身，
    /// 在源码里写死一个「不存在的词」会让它立刻存在 —— 对照模式在测试里用拼接构造
    /// （完整词元不落源码）。
    const PATTERNS: &[&str] = &[
        "tantivy",
        "Instant",
        "search",
        "unwrap",
        "worktree",
        "serde",
        "TODO",
        "命令面板",
        "工作树",
    ];

    // -----------------------------------------------------------------------
    // 计数分配器：量堆 live/peak（全局唯一；只在 cfg(test) 编译，生产构建无此物）

    #[global_allocator]
    static ALLOC: Counting = Counting;

    struct Counting;

    static HEAP_LIVE: AtomicUsize = AtomicUsize::new(0);
    static HEAP_PEAK: AtomicUsize = AtomicUsize::new(0);

    fn heap_live() -> usize {
        HEAP_LIVE.load(Ordering::Relaxed)
    }

    fn heap_peak() -> usize {
        HEAP_PEAK.load(Ordering::Relaxed)
    }

    /// 把峰值重置为当前 live：之后的 peak = 这段区间内的最大 live。
    fn heap_peak_reset() {
        HEAP_PEAK.store(HEAP_LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
    }

    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let ptr = System.alloc(layout);
            if !ptr.is_null() {
                let live = HEAP_LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
                HEAP_PEAK.fetch_max(live, Ordering::Relaxed);
            }
            ptr
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            HEAP_LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            System.dealloc(ptr, layout)
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let new_ptr = System.realloc(ptr, layout, new_size);
            if !new_ptr.is_null() {
                HEAP_LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
                let live = HEAP_LIVE.fetch_add(new_size, Ordering::Relaxed) + new_size;
                HEAP_PEAK.fetch_max(live, Ordering::Relaxed);
            }
            new_ptr
        }
    }

    // -----------------------------------------------------------------------
    // 语料

    struct CorpusFile {
        rel: String,
        /// 行尾已归一（\r\n → \n）的正文：行数、指纹、索引都用它。
        text: String,
        bytes: u64,
        lines: usize,
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR has a parent")
            .to_path_buf()
    }

    /// 与生产 `repo_grep` 同口径的文件清单：候选过滤链（目录忽略表 + 扩展名
    /// 白名单）逐项照抄 `searchgrep.rs`，深度 8，不跟随符号链接。
    fn scan_paths(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for r in CORPUS_ROOTS {
            let entries = WalkDir::new(root.join(r))
                .max_depth(8)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    if e.file_type().is_dir() {
                        !IGNORE_DIRS.contains(&e.file_name().to_string_lossy().as_ref())
                    } else {
                        e.path()
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .map(|ext| INCLUDE_EXTS.contains(&ext.to_lowercase().as_str()))
                            .unwrap_or(false)
                    }
                });
            for entry in entries {
                if entry.file_type().is_file() {
                    out.push(entry.into_path());
                }
            }
        }
        out.sort_by_key(|p| p.to_string_lossy().to_string());
        out
    }

    fn collect_corpus(root: &Path) -> (Vec<CorpusFile>, usize) {
        let mut files = Vec::new();
        let mut skipped = 0usize;
        for path in scan_paths(root) {
            let raw = match fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let bytes = raw.len() as u64;
            let text = raw.replace("\r\n", "\n");
            let lines = text.lines().count();
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().to_string());
            files.push(CorpusFile {
                rel,
                text,
                bytes,
                lines,
            });
        }
        (files, skipped)
    }

    /// 语料指纹：FNV-1a 64（非密码学，只为「同一份语料同一个值」），
    /// 覆盖 `相对路径 + \0 + 归一化正文 + \0`，逐文件按路径序。
    fn fingerprint(files: &[CorpusFile]) -> String {
        let mut h: u64 = 0xcbf29ce484222325;
        let mix = |bytes: &[u8], h: &mut u64| {
            for b in bytes {
                *h ^= *b as u64;
                *h = h.wrapping_mul(0x100_0000_01b3);
            }
        };
        for f in files {
            mix(f.rel.as_bytes(), &mut h);
            mix(&[0], &mut h);
            mix(f.text.as_bytes(), &mut h);
            mix(&[0xff], &mut h);
        }
        format!("fnv1a64:{h:016x}")
    }

    // -----------------------------------------------------------------------
    // 延迟统计（最近秩：P(分位) = ceil(q*n) 的第 k 个样本，1-based）

    fn percentile(sorted: &[Duration], q: f64) -> Duration {
        assert!(!sorted.is_empty(), "percentile 需要非空样本");
        let rank = (q * sorted.len() as f64).ceil() as usize;
        let idx = rank.max(1).saturating_sub(1).min(sorted.len() - 1);
        sorted[idx]
    }

    struct Latency {
        n: usize,
        p50_us: f64,
        p95_us: f64,
    }

    fn summarise(mut samples: Vec<Duration>) -> Latency {
        samples.sort();
        let us = |d: Duration| d.as_secs_f64() * 1e6;
        Latency {
            n: samples.len(),
            p50_us: us(percentile(&samples, 0.5)),
            p95_us: us(percentile(&samples, 0.95)),
        }
    }

    fn round2(v: f64) -> f64 {
        (v * 100.0).round() / 100.0
    }

    // -----------------------------------------------------------------------
    // tantivy：建索引与查询

    /// 与「哪个文件包含这个词」对齐的 doc 粒度：一文件一 doc，
    /// `path` 只存不索引、`text` 只索引不存（索引体积测的是倒排，不背正文存储）。
    fn build_index(index_dir: &Path, corpus: &[CorpusFile]) -> (Index, BuildStats) {
        if index_dir.exists() {
            fs::remove_dir_all(index_dir).expect("clean previous index dir");
        }
        fs::create_dir_all(index_dir).expect("create index dir");

        let mut sb = Schema::builder();
        let path_f = sb.add_text_field("path", STORED);
        let text_f = sb.add_text_field("text", TEXT);
        let schema = sb.build();

        let t0 = Instant::now();
        let index = Index::create_in_dir(index_dir, schema).expect("create index in dir");
        let writer: IndexWriter<TantivyDocument> = index.writer(WRITER_BUDGET).expect("writer");
        let t_prepare = t0.elapsed();

        let t_add = Instant::now();
        for f in corpus {
            writer
                .add_document(doc!(path_f => f.rel.as_str(), text_f => f.text.as_str()))
                .expect("add document");
        }
        let add = t_add.elapsed();

        let t_commit = Instant::now();
        let mut writer = writer;
        writer.commit().expect("commit");
        let commit = t_commit.elapsed();
        drop(writer);

        let stats = BuildStats {
            prepare_ms: ms(t_prepare),
            add_ms: ms(add),
            commit_ms: ms(commit),
            total_ms: ms(t_prepare + add + commit),
            docs: corpus.len(),
        };
        (index, stats)
    }

    fn ms(d: Duration) -> f64 {
        round2(d.as_secs_f64() * 1e3)
    }

    struct BuildStats {
        prepare_ms: f64,
        add_ms: f64,
        commit_ms: f64,
        total_ms: f64,
        docs: usize,
    }

    /// 查询串 → tantivy 查询：用**索引同一个 default 分词器**把查询串切成词元，
    /// 词元间 OR（`Occur::Should`）。这正是 FTS 的查询语义，和正则子串扫描的差别
    /// （分词 vs 逐字符）由每模式的命中数并排暴露，不掩盖。
    fn tantivy_query(index: &Index, field: Field, pattern: &str) -> Box<dyn Query> {
        let mut analyzer = index
            .tokenizers()
            .get("default")
            .expect("tantivy default tokenizer is registered");
        let mut stream = analyzer.token_stream(pattern);
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        while stream.advance() {
            let token = stream.token();
            clauses.push((
                Occur::Should,
                Box::new(TermQuery::new(
                    Term::from_field_text(field, &token.text),
                    IndexRecordOption::Basic,
                )),
            ));
        }
        Box::new(BooleanQuery::from(clauses))
    }

    // -----------------------------------------------------------------------
    // walkdir 正则扫描（`repo_grep` 的语义，去掉它的 limit：选型表的 ~1-5s 说的是
    // 全量扫描的量级，截断过的数字没法对照）

    #[derive(Debug, Default, PartialEq, Eq, Clone)]
    struct GrepScan {
        files_scanned: usize,
        files_hit: usize,
        lines_hit: usize,
    }

    /// 冷扫描：每次都走目录 + 读盘 + 按行正则（`repo_grep` 单次调用的真实形状）。
    fn grep_cold(root: &Path, re: &Regex) -> GrepScan {
        let mut scan = GrepScan::default();
        for path in scan_paths(root) {
            scan.files_scanned += 1;
            let text = match fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let mut hit = false;
            for line in text.lines() {
                if re.is_match(line) {
                    scan.lines_hit += 1;
                    hit = true;
                }
            }
            if hit {
                scan.files_hit += 1;
            }
        }
        scan
    }

    /// 热扫描：正文预载进内存后只跑正则（把 walk+读盘剥掉，看纯 regex 的量级）。
    fn grep_warm(corpus: &[CorpusFile], re: &Regex) -> GrepScan {
        let mut scan = GrepScan::default();
        for f in corpus {
            scan.files_scanned += 1;
            let mut hit = false;
            for line in f.text.lines() {
                if re.is_match(line) {
                    scan.lines_hit += 1;
                    hit = true;
                }
            }
            if hit {
                scan.files_hit += 1;
            }
        }
        scan
    }

    // -----------------------------------------------------------------------
    // 杂项读数

    fn dir_size(dir: &Path) -> u64 {
        WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
            .sum()
    }

    /// 从 `src-tauri/Cargo.lock` 读某个直接依赖的实测版本（不猜）。
    fn dep_version(lock: &Path, wanted: &str) -> Option<String> {
        let text = fs::read_to_string(lock).ok()?;
        let mut cur = String::new();
        for line in text.lines() {
            let l = line.trim();
            if let Some(v) = l.strip_prefix("name = ") {
                cur = v.trim_matches('"').to_string();
            } else if let Some(v) = l.strip_prefix("version = ") {
                let hit = cur == wanted;
                cur.clear();
                if hit {
                    return Some(v.trim_matches('"').to_string());
                }
            }
        }
        None
    }

    fn rustc_version() -> String {
        Command::new("rustc")
            .arg("--version")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "rustc not on PATH".to_string())
    }

    /// 单段字节流的 FNV-1a 64 —— gold-set 文件字节用它，与离线对比工具的
    /// `fnv1a64` 同算法同输入（跨语言对账）。
    fn fnv1a64_bytes(bytes: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
        h
    }

    /// 运行环境块（两个基准 JSON 共用一份口径）。
    fn environment_json(root: &Path) -> serde_json::Value {
        let lock = root.join("src-tauri").join("Cargo.lock");
        let ver = |name: &str| dep_version(&lock, name).unwrap_or_else(|| "unknown".to_string());
        serde_json::json!({
            "profile": profile_name(),
            "debugAssertions": cfg!(debug_assertions),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "rustc": rustc_version(),
            "deps": {"tantivy": ver("tantivy"), "regex": ver("regex"), "walkdir": ver("walkdir")},
        })
    }

    fn profile_name() -> &'static str {
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    }

    // -----------------------------------------------------------------------
    // 基准本体

    /// r3-1 主基准：索引构建耗时 / 索引体积 / 查询延迟 P50+P95 / walkdir 冷热对照 /
    /// 堆内存。刻意 `#[ignore]`（全量语料 + 每模式重复取样，跑一次分钟级，
    /// 塞进日常 `cargo test --lib` 会拖慢门禁）。复现命令见模块头注释。
    #[test]
    #[ignore]
    fn r3_1_tantivy_selection_table_bench() {
        let root = repo_root();
        println!("r3-1 tantivy selection bench — repo root: {}", root.display());
        println!(
            "profile: {} (cfg!(debug_assertions) = {})",
            profile_name(),
            cfg!(debug_assertions)
        );

        // 1) 语料：真实行数如实报告
        let (corpus, skipped) = collect_corpus(&root);
        let files = corpus.len();
        let corpus_bytes: u64 = corpus.iter().map(|f| f.bytes).sum();
        let corpus_lines: usize = corpus.iter().map(|f| f.lines).sum();
        let fp = fingerprint(&corpus);
        assert!(files > 0, "语料为空 —— 从错误的工作目录跑了?");
        println!(
            "corpus: {files} files / {corpus_bytes} bytes / {corpus_lines} lines (str::lines, CRLF→LF 归一) / non-utf8 skipped = {skipped}"
        );
        println!("fingerprint: {fp}");

        // 2) 索引构建（堆峰值区间 = [构建前, commit 后]）
        heap_peak_reset();
        let heap_live_before_build = heap_live();
        let bench_root = root.join(BENCH_DIR);
        let index_dir = bench_root.join(INDEX_SUBDIR);
        let (index, build) = build_index(&index_dir, &corpus);
        let heap_live_after_build = heap_live();
        let heap_peak_build = heap_peak();
        let index_bytes = dir_size(&index_dir);
        println!(
            "index: docs={} build total={}ms (prepare {} + add {} + commit {}) size={} bytes",
            build.docs, build.total_ms, build.prepare_ms, build.add_ms, build.commit_ms, index_bytes
        );
        assert!(index_bytes > 0, "索引目录是空的 —— commit 没落盘?");
        assert!(corpus_lines >= files, "行数应当不小于文件数");

        // 3) 查询：warmup 后重复取样；命中数与延迟分开量
        let schema = index.schema();
        let text_f = schema.get_field("text").expect("field text");
        let reader = index.reader().expect("index reader");
        let searcher = reader.searcher();

        heap_peak_reset();
        let heap_live_before_queries = heap_live();

        struct Row {
            pattern: String,
            t_hits: usize,
            t: Latency,
            cold: GrepScan,
            cold_l: Latency,
            warm: GrepScan,
            warm_l: Latency,
        }
        let mut rows: Vec<Row> = Vec::new();
        let mut all_t: Vec<Duration> = Vec::new();
        let mut all_cold: Vec<Duration> = Vec::new();
        let mut all_warm: Vec<Duration> = Vec::new();
        let mut cold_baseline: Option<GrepScan> = None;

        // 零命中对照：完整词元用拼接构造、不写进源码 —— 语料含本文件自身，
        // const 里写死一个「不存在的词」它就存在了（实测踩过：qzxjv 一词命中 1 文件）。
        let absent_pattern: String = ["qz", "xjv", "9"].concat();
        let mut all_patterns: Vec<String> = PATTERNS.iter().map(|s| (*s).to_string()).collect();
        all_patterns.push(absent_pattern.clone());

        for pattern in &all_patterns {
            let re = Regex::new(&format!("(?i){}", regex::escape(pattern))).expect("literal regex");
            let q = tantivy_query(&index, text_f, pattern);

            let t_hits = searcher.search(&*q, &Count).expect("tantivy count");
            for _ in 0..TANTIVY_WARMUP {
                searcher
                    .search(&*q, &TopDocs::with_limit(10))
                    .expect("tantivy warmup");
            }
            let mut samples = Vec::with_capacity(TANTIVY_REPEATS);
            for _ in 0..TANTIVY_REPEATS {
                let t0 = Instant::now();
                searcher
                    .search(&*q, &TopDocs::with_limit(10))
                    .expect("tantivy search");
                samples.push(t0.elapsed());
            }
            all_t.extend(samples.iter().copied());
            let t_lat = summarise(samples);

            for _ in 0..COLD_WARMUP {
                grep_cold(&root, &re);
            }
            let mut samples = Vec::with_capacity(COLD_REPEATS);
            let mut cold: Option<GrepScan> = None;
            for _ in 0..COLD_REPEATS {
                let t0 = Instant::now();
                let scan = grep_cold(&root, &re);
                samples.push(t0.elapsed());
                match cold.take() {
                    None => cold = Some(scan),
                    Some(prev) => {
                        assert_eq!(
                            prev, scan,
                            "同一模式多次冷扫描的统计必须一致（文件集在跑动中变了）"
                        );
                        cold = Some(prev);
                    }
                }
            }
            let cold = cold.expect("COLD_REPEATS > 0");
            match cold_baseline.take() {
                None => cold_baseline = Some(cold.clone()),
                Some(prev) => {
                    assert_eq!(
                        prev.files_scanned, cold.files_scanned,
                        "每次冷扫描的文件清单大小必须一致"
                    );
                    cold_baseline = Some(prev);
                }
            }
            all_cold.extend(samples.iter().copied());
            let cold_lat = summarise(samples);

            for _ in 0..WARM_WARMUP {
                grep_warm(&corpus, &re);
            }
            let mut samples = Vec::with_capacity(WARM_REPEATS);
            let mut warm: Option<GrepScan> = None;
            for _ in 0..WARM_REPEATS {
                let t0 = Instant::now();
                let scan = grep_warm(&corpus, &re);
                samples.push(t0.elapsed());
                match warm.take() {
                    None => warm = Some(scan),
                    Some(prev) => {
                        assert_eq!(prev, scan, "热扫描统计必须确定");
                        warm = Some(prev);
                    }
                }
            }
            let warm = warm.expect("WARM_REPEATS > 0");
            all_warm.extend(samples.iter().copied());
            let warm_lat = summarise(samples);

            rows.push(Row {
                pattern: pattern.clone(),
                t_hits,
                t: t_lat,
                cold,
                cold_l: cold_lat,
                warm,
                warm_l: warm_lat,
            });
        }

        let heap_live_after_queries = heap_live();
        let heap_peak_queries = heap_peak();

        // 4) 索引体积复查（查询之后）：看段合并有没有改大小
        let index_bytes_after = dir_size(&index_dir);

        // 基准自身的正确性断言：拿「必须有命中」的模式兜底，坏掉的口径不许静默出表
        let expect = rows.iter().find(|r| r.pattern == "tantivy").expect("tantivy 行");
        assert!(expect.t_hits > 0, "tantivy 对自名词 0 命中 —— 查询/分词口径坏了");
        assert!(expect.cold.files_hit > 0, "正则扫描对 tantivy 0 命中 —— 文件清单口径坏了");
        let absent = rows
            .iter()
            .find(|r| r.pattern == absent_pattern)
            .expect("零命中对照行");
        assert_eq!(absent.t_hits, 0, "刻意不存在的模式必须 0 命中");
        assert_eq!(absent.cold.files_hit, 0, "刻意不存在的模式必须 0 命中");
        let scanned = cold_baseline.expect("cold baseline").files_scanned;
        assert_eq!(
            scanned,
            files + skipped,
            "冷扫描应当恰好走完语料清单（成功读取 + 读失败）"
        );

        // 5) stdout：人类可读表格
        let t_all = summarise(all_t);
        let cold_all = summarise(all_cold);
        let warm_all = summarise(all_warm);
        println!();
        println!(
            "{:<10} {:>11} {:>11} {:>7} | {:>11} {:>11} {:>7} {:>7} | {:>11} {:>11} {:>7}",
            "pattern", "t-p50(us)", "t-p95(us)", "t-hit", "cold-p50(ms)", "cold-p95(ms)", "c-file", "c-line", "warm-p50(ms)", "warm-p95(ms)", "w-file"
        );
        for r in &rows {
            println!(
                "{:<10} {:>11.2} {:>11.2} {:>7} | {:>11.2} {:>11.2} {:>7} {:>7} | {:>11.2} {:>11.2} {:>7}",
                r.pattern,
                r.t.p50_us,
                r.t.p95_us,
                r.t_hits,
                r.cold_l.p50_us / 1000.0,
                r.cold_l.p95_us / 1000.0,
                r.cold.files_hit,
                r.cold.lines_hit,
                r.warm_l.p50_us / 1000.0,
                r.warm_l.p95_us / 1000.0,
                r.warm.files_hit,
            );
        }
        println!(
            "{:<10} {:>11.2} {:>11.2} {:>7} | {:>11.2} {:>11.2} {:>7} {:>7} | {:>11.2} {:>11.2}",
            "ALL",
            t_all.p50_us,
            t_all.p95_us,
            "-",
            cold_all.p50_us / 1000.0,
            cold_all.p95_us / 1000.0,
            "-",
            "-",
            warm_all.p50_us / 1000.0,
            warm_all.p95_us / 1000.0,
        );
        let ratio = index_bytes as f64 / corpus_bytes as f64 * 100.0;
        println!(
            "size: index {} B vs corpus {} B = {:.1}% (选型表「约15%膨胀」的对照口径；膨胀=索引目录/语料字节)",
            index_bytes, corpus_bytes, ratio
        );
        if index_bytes_after != index_bytes {
            println!(
                "size: 查询后复查 {} B（段合并发生过，引用体积请以本行复查值为准）",
                index_bytes_after
            );
        }
        println!(
            "heap: live(before build)={} B, peak(build)={} B, live(after commit)={} B, peak(queries)={} B, live(after)={} B  [计数分配器的堆，不是 RSS]",
            heap_live_before_build,
            heap_peak_build,
            heap_live_after_build,
            heap_peak_queries,
            heap_live_after_queries
        );

        // 6) 机器可读 JSON
        let pattern_json: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| {
                serde_json::json!({
                    "pattern": r.pattern,
                    "tantivy": {"hits": r.t_hits, "p50Us": round2(r.t.p50_us), "p95Us": round2(r.t.p95_us), "samples": r.t.n},
                    "walkdirCold": {"filesHit": r.cold.files_hit, "linesHit": r.cold.lines_hit, "filesScanned": r.cold.files_scanned, "p50Us": round2(r.cold_l.p50_us), "p95Us": round2(r.cold_l.p95_us), "samples": r.cold_l.n},
                    "walkdirWarm": {"filesHit": r.warm.files_hit, "linesHit": r.warm.lines_hit, "filesScanned": r.warm.files_scanned, "p50Us": round2(r.warm_l.p50_us), "p95Us": round2(r.warm_l.p95_us), "samples": r.warm_l.n},
                })
            })
            .collect();
        let payload = serde_json::json!({
            "bench": "r3-1-tantivy-selection-table",
            "command": REPRO_COMMAND,
            "environment": environment_json(&root),
            "corpus": {
                "roots": CORPUS_ROOTS,
                "fileScope": "walkdir 深度8 + 候选过滤链（IGNORE_DIRS/INCLUDE_EXTS）逐项同生产 repo_grep 的扫描逻辑",
                "files": files,
                "nonUtf8Skipped": skipped,
                "bytes": corpus_bytes,
                "lines": corpus_lines,
                "lineCountMethod": "str::lines() over CRLF→LF normalized text",
                "fingerprint": fp,
                "fingerprintMethod": "FNV-1a 64 over (relpath + 0x00 + normalized content + 0xff) per file, sorted by path; 非密码学哈希",
            },
            "index": {
                "docGranularity": "一文件一 doc；path 只存不索引，text 只索引不存正文 —— 选型表「10万行索引」没写 doc 粒度，此处显式声明",
                "docs": build.docs,
                "corpusLinesCovered": corpus_lines,
                "writerBudgetBytes": WRITER_BUDGET,
                "buildMs": {"prepare": build.prepare_ms, "add": build.add_ms, "commit": build.commit_ms, "total": build.total_ms},
                "buildMsNote": "tantivy writer 异步入队：addMs 只是把文档塞进队列的耗时，实际分词/倒排/写盘发生在 commitMs（commit 等 worker 完成并落盘）。整段构建口径看 totalMs。",
                "sizeBytes": index_bytes,
                "sizeAfterQueriesBytes": index_bytes_after,
                "corpusBytes": corpus_bytes,
                "sizeVsCorpusPct": round2(ratio),
            },
            "queries": {
                "patterns": pattern_json,
                "aggregate": {
                    "tantivy": {"p50Us": round2(t_all.p50_us), "p95Us": round2(t_all.p95_us), "samples": t_all.n},
                    "walkdirCold": {"p50Us": round2(cold_all.p50_us), "p95Us": round2(cold_all.p95_us), "samples": cold_all.n},
                    "walkdirWarm": {"p50Us": round2(warm_all.p50_us), "p95Us": round2(warm_all.p95_us), "samples": warm_all.n},
                },
                "warmup": {"tantivy": TANTIVY_WARMUP, "walkdirCold": COLD_WARMUP, "walkdirWarm": WARM_WARMUP},
                "repeats": {"tantivy": TANTIVY_REPEATS, "walkdirCold": COLD_REPEATS, "walkdirWarm": WARM_REPEATS},
                "querySemantics": "tantivy = 查询串过 default 分词器后词元 OR（FTS 语义）；walkdir = (?i)+regex::escape 字面子串按行（repo_grep 语义）。命中数并排给出，口径差不隐藏",
                "percentileMethod": "最近秩：rank = ceil(q*n)，1-based；小样本（如 cold n=20）的 P95 接近最大值",
            },
            "memory": {
                "unit": "bytes（本进程堆，计数分配器；不含 mmap 段文件与二进制映射，不是进程 RSS）",
                "liveBeforeBuild": heap_live_before_build,
                "peakDuringBuild": heap_peak_build,
                "liveAfterCommit": heap_live_after_build,
                "liveBeforeQueries": heap_live_before_queries,
                "peakDuringQueries": heap_peak_queries,
                "liveAfterQueries": heap_live_after_queries,
            },
            "timingMethod": "std::time::Instant 单查询计时；每模式先 warmup（见 queries.warmup）再重复 queries.repeats 次；P50/P95 最近秩；冷扫描含 walk+读盘+正则，热扫描正文预载只跑正则；跨实现对比只看同列（t/cold/warm）",
            "cleanUp": "Remove-Item -Recurse .pack\\tantivy-bench   （索引与本 JSON 同目录；.pack/ 已在 .gitignore）",
        });
        fs::create_dir_all(&bench_root).expect("create bench dir");
        let out = bench_root.join(RESULT_JSON);
        fs::write(&out, serde_json::to_string_pretty(&payload).expect("json")).expect("write json");
        println!("json: {}", out.display());
        println!("cleanup: Remove-Item -Recurse .pack\\tantivy-bench");
    }

    /// 基准脚手架自检（不 ignore，随 `cargo test --lib` 走）：把「口径写错了但表照样
    /// 打得出来」的风险钉在门禁里——分位数最近秩、语料采集两次同指纹、RAM 索引的
    /// 词元查询命中数、冷/热扫描在同一正则下命中的文件集合一致。
    #[test]
    fn bench_scaffold_selftest() {
        let samples: Vec<Duration> = (1..=100u64).map(Duration::from_millis).collect();
        assert_eq!(percentile(&samples, 0.5), Duration::from_millis(50));
        assert_eq!(percentile(&samples, 0.95), Duration::from_millis(95));
        assert_eq!(percentile(&samples, 1.0), Duration::from_millis(100));
        let short: Vec<Duration> = (1..=15u64).map(Duration::from_millis).collect();
        // 小样本口径：ceil(0.95*15)=15 → 最大值。这不是缺陷，是最近秩的定义，
        // 输出 JSON 的 percentileMethod 已把它写明。
        assert_eq!(percentile(&short, 0.95), Duration::from_millis(15));

        let root = repo_root();
        let (first, skipped1) = collect_corpus(&root);
        let (second, skipped2) = collect_corpus(&root);
        assert!(first.len() >= 3, "语料至少该有 3 个文件");
        assert_eq!(first.len(), second.len(), "两次采集文件数一致");
        assert_eq!(skipped1, skipped2, "两次采集的跳过数一致");
        assert_eq!(
            fingerprint(&first),
            fingerprint(&second),
            "同一份语料两次采集指纹必须一致"
        );
        for r in CORPUS_ROOTS {
            assert!(
                first.iter().any(|f| f.rel.starts_with(r)),
                "根 {r} 一个文件都没采到"
            );
        }
        let total_lines: usize = first.iter().map(|f| f.lines).sum();
        assert!(total_lines >= first.len(), "行数不小于文件数");

        // RAM 索引：词元查询命中数 + 存储字段可取回
        let mut sb = Schema::builder();
        let path_f = sb.add_text_field("path", STORED);
        let text_f = sb.add_text_field("text", TEXT);
        let schema = sb.build();
        let index = Index::create_in_ram(schema);
        let writer: IndexWriter<TantivyDocument> = index
            .writer(RAM_WRITER_BUDGET)
            .expect("ram writer budget >= tantivy min");
        writer
            .add_document(doc!(path_f => "a.txt", text_f => "alpha beta"))
            .expect("add a");
        writer
            .add_document(doc!(path_f => "b.txt", text_f => "beta gamma"))
            .expect("add b");
        writer
            .add_document(doc!(path_f => "c.txt", text_f => "delta"))
            .expect("add c");
        let mut writer = writer;
        writer.commit().expect("ram commit");
        drop(writer);
        let searcher = index.reader().expect("ram reader").searcher();
        let q = tantivy_query(&index, text_f, "beta");
        assert_eq!(searcher.search(&*q, &Count).expect("count"), 2);
        let top = searcher
            .search(&*q, &TopDocs::with_limit(10))
            .expect("top");
        assert_eq!(top.len(), 2);
        let stored: TantivyDocument = searcher.doc(top[0].1).expect("stored doc");
        let path = match stored.get_first(path_f) {
            Some(OwnedValue::Str(s)) => s.as_str(),
            _ => "",
        };
        assert!(path == "a.txt" || path == "b.txt", "存储的 path 取回错乱：{path}");

        // 冷/热扫描在同一正则下的命中文件集合必须一致（两种实现互为交叉核对）
        let re = Regex::new(&format!("(?i){}", regex::escape("tantivy"))).expect("literal regex");
        let warm = grep_warm(&first, &re);
        let cold = grep_cold(&root, &re);
        assert!(warm.files_hit > 0, "语料里应有 tantivy 命中");
        assert_eq!(
            warm.files_hit, cold.files_hit,
            "冷热扫描命中文件数不一致 —— 文件集或正则口径漂了"
        );
        assert_eq!(
            cold.files_scanned,
            first.len() + skipped1,
            "冷扫描清单应等于语料采集清单"
        );
    }

    // =======================================================================
    // R3-2：gold-set 质量与跨语言计时的 Rust 半边
    //
    // 三个 tantivy 变体 + 一个真实 rust-grep，全部跑 R1 的同一份 gold-set
    // （同 48 篇语料、同 36 条查询）。指标**不在这里算**：
    // 本文件只产出每候选每查询的 ranked 与计时，离线对比工具
    // 用与 search bakeoff 同一个 metricsFor 对两边统一重算 —— 两套公式各算各的
    // 是跨语言比较最经典的翻车点。

    /// gold-set.json 的结构（只声明用得到的字段；serde 忽略未声明字段）。
    #[derive(serde::Deserialize)]
    struct GoldEntry {
        slug: String,
        repo: String,
        owner: String,
        path: String,
        alias: Option<String>,
        description: Option<String>,
        #[serde(rename = "readmeHeadings")]
        readme_headings: Option<Vec<String>>,
        tags: Option<Vec<String>>,
    }

    #[derive(serde::Deserialize)]
    struct GoldQuery {
        id: String,
        query: String,
    }

    #[derive(serde::Deserialize)]
    struct GoldPayload {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        corpus: Vec<GoldEntry>,
        queries: Vec<GoldQuery>,
    }

    /// CJK 单字化：与 `src/lib/bm25.ts` 的 `TOKEN_RE` 同三段 Han 区间
    /// （U+3400–4DBF / U+4E00–9FFF / U+F900–FAFF），索引与查询走同一个函数 ——
    /// 对齐渲染侧「单字 unigram、无分词器依赖」的设计（`docs/local-search-bm25.md` §3），
    /// 不引入 tantivy-jieba 之类的新依赖。
    fn cjk_unigram(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for ch in s.chars() {
            if matches!(ch as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF) {
                out.push(' ');
                out.push(ch);
                out.push(' ');
            } else {
                out.push(ch);
            }
        }
        out
    }

    /// 字段权重：逐字对应 `src/lib/local-index.ts` 的 `LOCAL_FIELD_WEIGHTS`
    /// （alias 3.5 / name 3 / description 2 / readme 1.5 = tags 1.5 / owner 1.2 / path 1）。
    /// 改那边就要改这里 —— `tantivy-cjk-weighted` 靠它与 `bm25-local` 同权重对齐。
    const GOLD_FIELD_WEIGHTS: &[(&str, f32)] = &[
        ("alias", 3.5),
        ("name", 3.0),
        ("description", 2.0),
        ("readme", 1.5),
        ("tags", 1.5),
        ("owner", 1.2),
        ("path", 1.0),
    ];

    struct GoldIndex {
        index: Index,
        slug_f: Field,
        /// (字段, 权重) —— 查询子句按这张表跨字段展开
        fields: Vec<(Field, f32)>,
        build_ms: f64,
        /// true = 字段值经过 `cjk_unigram` 预处理（查询侧同样处理，保证对称）
        cjk: bool,
    }

    fn put_text(doc: &mut TantivyDocument, field: Field, value: Option<String>, cjk: bool) {
        let text = match value {
            Some(v) if !v.is_empty() => v,
            _ => return,
        };
        let prepared = if cjk { cjk_unigram(&text) } else { text };
        doc.add_field_value(field, prepared.as_str());
    }

    /// 48 篇 gold 语料 → RAM 索引（一文档一条目；slug 存起来供排名回读）。
    fn build_gold_index(gold: &GoldPayload, cjk: bool) -> GoldIndex {
        let t0 = Instant::now();
        let mut sb = Schema::builder();
        let slug_f = sb.add_text_field("slug", STRING | STORED);
        let mut field_ids: Vec<(Field, f32)> = Vec::new();
        let mut name_of: std::collections::HashMap<&str, Field> = std::collections::HashMap::new();
        for (name, weight) in GOLD_FIELD_WEIGHTS {
            let f = sb.add_text_field(name, TEXT);
            name_of.insert(*name, f);
            field_ids.push((f, *weight));
        }
        let schema = sb.build();
        let index = Index::create_in_ram(schema);
        let writer: IndexWriter<TantivyDocument> = index
            .writer(RAM_WRITER_BUDGET)
            .expect("gold writer budget >= tantivy min");
        for e in &gold.corpus {
            let mut doc = TantivyDocument::default();
            doc.add_field_value(slug_f, e.slug.as_str());
            put_text(&mut doc, name_of["name"], Some(e.repo.clone()), cjk);
            put_text(&mut doc, name_of["alias"], e.alias.clone(), cjk);
            put_text(&mut doc, name_of["description"], e.description.clone(), cjk);
            put_text(
                &mut doc,
                name_of["readme"],
                e.readme_headings.as_ref().map(|h| h.join(" ")),
                cjk,
            );
            put_text(&mut doc, name_of["tags"], e.tags.as_ref().map(|t| t.join(" ")), cjk);
            put_text(&mut doc, name_of["owner"], Some(e.owner.clone()), cjk);
            put_text(&mut doc, name_of["path"], Some(e.path.clone()), cjk);
            writer.add_document(doc).expect("add gold doc");
        }
        let mut writer = writer;
        writer.commit().expect("gold commit");
        drop(writer);
        GoldIndex {
            index,
            slug_f,
            fields: field_ids,
            build_ms: ms(t0.elapsed()),
            cjk,
        }
    }

    /// 查询串 → 跨 7 字段的 OR 查询（查询与索引走同一个分词路径）；
    /// `weighted` 时按 `GOLD_FIELD_WEIGHTS` 给子句加 Boost。
    fn gold_query(gi: &GoldIndex, raw: &str, weighted: bool) -> Box<dyn Query> {
        let prepared = if gi.cjk { cjk_unigram(raw) } else { raw.to_string() };
        let mut analyzer = gi.index.tokenizers().get("default").expect("default tokenizer");
        let mut stream = analyzer.token_stream(&prepared);
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        while stream.advance() {
            let token = stream.token().text.clone();
            for (field, weight) in &gi.fields {
                let plain: Box<dyn Query> = Box::new(TermQuery::new(
                    Term::from_field_text(*field, &token),
                    IndexRecordOption::Basic,
                ));
                let clause: Box<dyn Query> = if weighted && *weight != 1.0 {
                    Box::new(BoostQuery::new(plain, *weight))
                } else {
                    plain
                };
                clauses.push((Occur::Should, clause));
            }
        }
        Box::new(BooleanQuery::from(clauses))
    }

    /// 整语料排名（分数降序，同分按 slug 码点升序 —— 与 `bm25.ts` 的确定性规则同款）。
    fn gold_rank(
        gi: &GoldIndex,
        searcher: &Searcher,
        raw: &str,
        weighted: bool,
        limit: usize,
    ) -> Vec<String> {
        let q = gold_query(gi, raw, weighted);
        let top = searcher
            .search(&*q, &TopDocs::with_limit(limit))
            .expect("gold search");
        let mut rows: Vec<(f32, String)> = Vec::with_capacity(top.len());
        for (score, addr) in top {
            let doc: TantivyDocument = searcher.doc(addr).expect("stored slug doc");
            let slug = match doc.get_first(gi.slug_f) {
                Some(OwnedValue::Str(s)) => s.clone(),
                _ => String::new(),
            };
            rows.push((score, slug));
        }
        rows.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.1.cmp(&b.1))
        });
        rows.into_iter().map(|(_, slug)| slug).collect()
    }

    /// 真实 Rust 实现的文档级 grep 排名：与 `grep-proxy`（Node 复刻）逐项同语义 ——
    /// 字面量转义正则、`(?i)`、按行匹配、每文件 cap 500、命中行数降序 + 路径码点升序。
    fn gold_grep_rank(texts: &[(String, Vec<String>)], query: &str) -> Vec<String> {
        let re = Regex::new(&format!("(?i){}", regex::escape(query))).expect("literal regex");
        let mut counts: Vec<(usize, String)> = Vec::new();
        for (slug, lines) in texts {
            let mut n = 0usize;
            for line in lines {
                if re.is_match(line) {
                    n += 1;
                    if n >= 500 {
                        break;
                    }
                }
            }
            if n > 0 {
                counts.push((n, slug.clone()));
            }
        }
        counts.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        counts.into_iter().map(|(_, slug)| slug).collect()
    }

    /// r3-2 主测试：产出 `.pack/tantivy-bench/tantivy-quality.json`。
    /// 刻意 `#[ignore]`（与 r3-1 同一条复现命令，见 `REPRO_COMMAND`）；质量本身
    /// 由离线对比工具统一重算并交叉核对。
    #[test]
    #[ignore]
    fn r3_2_gold_quality() {
        let root = repo_root();
        let gold_path = root.join("scripts").join("bench").join("gold-set.json");
        let gold_bytes = fs::read(&gold_path)
            .expect("gold-set.json 缺失 —— 先跑 node scripts/bench/build-gold-set.mjs");
        let gold: GoldPayload =
            serde_json::from_slice(&gold_bytes).expect("gold-set.json 解析失败");
        assert_eq!(gold.schema_version, 1, "gold schemaVersion 必须是 1");
        let queries = gold.queries.len();
        assert!(
            gold.corpus.len() >= 40 && queries >= 30,
            "gold 规模应当与 R1 口径一致（48 篇 / 36 条）"
        );
        let gold_fnv = format!("fnv1a64:{:016x}", fnv1a64_bytes(&gold_bytes));

        // ---- 候选 1：默认分词；候选 2/3：CJK 单字索引（同一个 RAM 索引共用）----
        let ob = build_gold_index(&gold, false);
        let cjk = build_gold_index(&gold, true);
        let ob_reader = ob.index.reader().expect("ob reader");
        let cjk_reader = cjk.index.reader().expect("cjk reader");
        let ob_searcher = ob_reader.searcher();
        let cjk_searcher = cjk_reader.searcher();

        // ---- 候选 4：真实 rust-grep（读盘 + 按行切分计进 buildMs，与 grep-proxy 同口径）----
        let t_grep = Instant::now();
        let mut grep_texts: Vec<(String, Vec<String>)> = Vec::new();
        for e in &gold.corpus {
            let text = fs::read_to_string(root.join(&e.path))
                .unwrap_or_else(|_| panic!("语料文件不可读：{}", e.path));
            grep_texts.push((
                e.slug.clone(),
                text.split('\n').map(str::to_string).collect(),
            ));
        }
        let grep_build_ms = ms(t_grep.elapsed());

        enum Kind {
            ObUniform,
            CjkUniform,
            CjkWeighted,
            Grep,
        }
        let kinds = [Kind::ObUniform, Kind::CjkUniform, Kind::CjkWeighted, Kind::Grep];
        let n_docs = gold.corpus.len();
        let rank = |kind: &Kind, query: &str| -> Vec<String> {
            // 四个候选一律只交 top10 —— 指标口径是 Recall@10/MRR@10，
            // 交出第 11 名以后的列表会把 recall 灌水（实测踩过：rust-grep 少切
            // 一刀，q12/q29 各多出 3/16 条，recall 0.7778 虚高于 grep-proxy 的 0.7546）。
            let top10 = |v: Vec<String>| v.into_iter().take(10).collect::<Vec<_>>();
            match kind {
                Kind::ObUniform => top10(gold_rank(&ob, &ob_searcher, query, false, n_docs)),
                Kind::CjkUniform => top10(gold_rank(&cjk, &cjk_searcher, query, false, n_docs)),
                Kind::CjkWeighted => top10(gold_rank(&cjk, &cjk_searcher, query, true, n_docs)),
                Kind::Grep => top10(gold_grep_rank(&grep_texts, query)),
            }
        };

        struct Meta {
            id: &'static str,
            note: String,
            build_ms: f64,
        }
        let metas = [
            Meta {
                id: "tantivy-out-of-box",
                note: "tantivy 0.22 默认分词（default：字母数字连续段 + 小写）+ 均匀权重 —— 「依赖装上直接用」的口径；中文整段成词，查询词元须与整段相等".into(),
                build_ms: ob.build_ms,
            },
            Meta {
                id: "tantivy-cjk-uniform",
                note: "索引与查询前把 Han 区间切单字（与 src/lib/bm25.ts 的 TOKEN_RE 同三段区间）+ 均匀权重 —— 与渲染侧同分词设计、不新增依赖；与 tantivy-cjk-weighted 共用同一个 RAM 索引，buildMs 是同一次构建".into(),
                build_ms: cjk.build_ms,
            },
            Meta {
                id: "tantivy-cjk-weighted",
                note: "同 cjk 索引 + BoostQuery 按 LOCAL_FIELD_WEIGHTS 加权（alias3.5>name3>description2>readme1.5=tags1.5>owner1.2>path1）—— 与 bm25-local 同字段同权重的对齐口径".into(),
                build_ms: cjk.build_ms,
            },
            Meta {
                id: "rust-grep",
                note: "真实 Rust walkdir+regex 语义的文档级排名：字面量转义、(?i)、按行、每文件 cap500、命中行数降序 + 路径码点升序 —— 与 grep-proxy 同款语义的跨语言对照（读盘 + 切行计进 buildMs）".into(),
                build_ms: grep_build_ms,
            },
        ];

        // ---- 质量：每候选 × 每查询的 ranked（确定性：分数降序、同分 slug 升序）----
        let mut per_query: Vec<serde_json::Value> = Vec::new();
        for (meta, kind) in metas.iter().zip(kinds.iter()) {
            for q in &gold.queries {
                let ranked = rank(kind, &q.query);
                assert!(
                    ranked.len() <= 10,
                    "{} 对 {} 的 ranked 有 {} 条 > top10",
                    meta.id,
                    q.id,
                    ranked.len()
                );
                per_query.push(serde_json::json!({
                    "candidate": meta.id,
                    "id": q.id,
                    "query": q.query,
                    "ranked": ranked,
                }));
            }
        }
        assert_eq!(
            per_query.len(),
            metas.len() * queries,
            "每候选 × 每查询都该有一行 ranked"
        );

        // ---- 基准自检：确切命中 + 必非空（坏掉的口径不许静默出表）----
        let q01 = gold.queries.iter().find(|q| q.id == "q01").expect("q01 存在");
        for (id, kind) in [
            ("tantivy-out-of-box", &kinds[0]),
            ("tantivy-cjk-uniform", &kinds[1]),
            ("tantivy-cjk-weighted", &kinds[2]),
        ] {
            let top = rank(kind, &q01.query);
            assert!(
                top.iter().any(|s| s == "docs/local-search-bm25.md"),
                "{id} 对 q01「{}」的 top10 必须含 gold 正例 docs/local-search-bm25.md，实得 {top:?}",
                q01.query
            );
        }
        assert!(
            !rank(&kinds[3], "命令面板").is_empty(),
            "rust-grep 对语料里真实存在的中文词必须有命中"
        );
        // 零命中对照同样必须运行时拼接 —— rust-grep 读的是**活文件**，本测试源码
        // 就在语料里，写死一个「不存在的查询」它就存在了（r3-1 踩过同款坑）。
        let absent_query = ["qz", "nth", "xyz"].join("-");
        assert!(
            rank(&kinds[3], &absent_query).is_empty() && rank(&kinds[0], &absent_query).is_empty(),
            "不存在的查询（{absent_query}）两边都必须空"
        );

        // ---- 计时：与离线 search bakeoff 逐字同口径（3 遍 warmup 不计，20 遍÷遍数÷查询数）----
        let mut sink = 0usize;
        let mut avg_ms: Vec<f64> = Vec::new();
        for kind in kinds.iter() {
            for _ in 0..3 {
                for q in &gold.queries {
                    sink += rank(kind, &q.query).len();
                }
            }
            let t0 = Instant::now();
            for _ in 0..20 {
                for q in &gold.queries {
                    sink += rank(kind, &q.query).len();
                }
            }
            let avg = t0.elapsed().as_secs_f64() * 1e3 / 20.0 / queries as f64;
            // 4 位小数：与 search-bakeoff 的 avgMsPerQuery 精度对齐（0.01ms 的粒度
            // 会把 0.096 与 0.104 抹成同一个 0.10，跨候选比较就不诚实了）。
            avg_ms.push((avg * 10000.0).round() / 10000.0);
        }

        // ---- 机器可读 JSON ----
        let mut candidates_json = serde_json::Map::new();
        for (i, meta) in metas.iter().enumerate() {
            candidates_json.insert(
                meta.id.to_string(),
                serde_json::json!({
                    "note": meta.note.clone(),
                    "buildMs": meta.build_ms,
                    "avgMsPerQuery": avg_ms[i],
                }),
            );
        }
        let payload = serde_json::json!({
            "bench": "r3-2-gold-quality",
            "command": REPRO_COMMAND,
            "environment": environment_json(&root),
            "gold": {
                "path": "scripts/bench/gold-set.json",
                "fnv1a64": gold_fnv,
                "fileBytes": gold_bytes.len(),
                "corpus": gold.corpus.len(),
                "queries": queries,
            },
            "candidates": candidates_json,
            "timingMethod": "与 scripts/search-bakeoff.mjs 逐字同口径：每候选 3 遍 warmup 不计，20 遍「全部查询」总时长 ÷ 20 ÷ 查询数 = avgMsPerQuery；buildMs 口径逐候选见 note（tantivy = 建 RAM 索引，rust-grep = 读盘 + 按行切分）",
            "timingSink": sink,
            "perQuery": per_query,
        });
        let bench_root = root.join(BENCH_DIR);
        fs::create_dir_all(&bench_root).expect("create bench dir");
        let out = bench_root.join(QUALITY_JSON);
        fs::write(&out, serde_json::to_string_pretty(&payload).expect("json"))
            .expect("write quality json");

        // ---- stdout 摘要（质量指标在 compare 脚本里统一算，这里只报成本）----
        println!("r3-2 gold quality — gold {gold_fnv} / {} 篇 / {queries} 条", gold.corpus.len());
        for (meta, avg) in metas.iter().zip(avg_ms.iter()) {
            println!(
                "candidate {:<22} build {:8.2} ms  {:8.4} ms/query",
                meta.id, meta.build_ms, avg
            );
        }
        println!("json: {}", out.display());
    }
}
