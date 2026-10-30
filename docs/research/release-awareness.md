# 发布感知：只读 Release 检查（r33-D6）

日期：2026-10-30。端点：`GET https://api.github.com/repos/{owner}/{repo}/releases/latest`。
实现：[`src-tauri/src/releases.rs`](../../src-tauri/src/releases.rs)。

## 1. 为什么只做“最新发布”，不做更新器

应用更新（替换 exe）需要签名清单、回滚与代码签名身份；本仓库当前是仅源码发布，
没有可执行产物可替换。`docs/research/update-architecture.md` 已记录该边界。
仓库的 Release 是**只读元数据**：拿到 tag/名称/URL/发布时间，打开浏览器即可，
不下载、不安装、不修改工作树。

## 2. 实测（2026-10-30，本机网络）

| 检查 | 结果 |
|---|---|
| `curl` 直连 `rust-lang/rust` 的 latest release | HTTP 200，2 263 B |
| `tag_name` | `1.99.1` |
| `prerelease` | `false` |
| `published_at` | `2026-10-16T04:47:44Z` |
| 响应字节量 | 约 2.2 KB（未请求 `per_page`；单对象） |

复现：

```bash
curl -sS -L --max-time 20 -H "Accept: application/vnd.github+json" \
  -H "User-Agent: DevHub" -o rel.json \
  -w "%{http_code} %{size_download}\n" \
  https://api.github.com/repos/rust-lang/rust/releases/latest
```

## 3. 预算与缓存

- 无令牌时 REST 额度 60 次/小时，与搜索、仓库预览共享；带令牌为 5 000 次/小时
  （GitHub REST 文档，读取日期 2026-10-30）。
- 因此：**不自动轮询**、不随项目墙加载；只在用户点「最新发布」时请求。
- 成功与 404（没有发布）缓存 6 小时；`force` 绕过；`If-None-Match` 命中 304
  不重新计费。缓存上限 200 个仓库，过期/最旧条目先淘汰。
- 403/401 原样报出；响应头 `x-ratelimit-remaining == 0` 时附带重置提示
  （复用 `search::rate_limit_hint`），不把“额度用尽”说成“仓库不存在”。

## 4. 诚实的边界

- 只读 `latest`；预发布不会出现在这个端点。`prerelease` 字段只在 GitHub 把某个
  预发布标记为 latest 时才会为真，界面照实标注，不推断“有没有更新版本”。
- 不比较本地 HEAD 与 release tag：两者不是同一种对象（tag 可能指向任意提交，
  仓库也可能没有本地 git 历史）。「新鲜度」仍由 `repo_freshness`（`git ls-remote`）
  回答，两者不互相替代。
- 私有仓库需要 token 且 token 具备 `repo` 权限；无 token 时只对公开仓库有答案。
- 未在真机 WebView2 中驱动该按钮；解析、缓存边界、slug 校验与 API 可用性已分别
  由单测与本机 curl 实测覆盖。
