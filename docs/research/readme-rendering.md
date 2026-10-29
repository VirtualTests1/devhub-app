# README 渲染的对抗性审计（r30-R2）

日期：2026-10-29。对象：`src/lib/markdown.ts`（零依赖的 Markdown 子集）及其调用方
`RepoReadmeDialog`、添加页的 README 预览。

## 1. 攻击面

README 是不可信输入：它来自被克隆的仓库，或来自 GitHub 的远端预览。它能控制的只有文本。
本应用不把 Markdown 变成 HTML 字符串，也不使用 `dangerouslySetInnerHTML`；解析器的产物是
`MdBlock`/`MdInline` 联合类型，React 渲染器逐类型构造元素。因此威胁不是“HTML 注入了 DOM”，
而是下面两类：

1. **链接目标**：`isSafeHref` 是唯一的导航白名单。任何让 `javascript:`/`data:`/`vbscript:`
   变成 `link.href` 的路径都是缺陷。
2. **输入形状**：一个只读预览不应该因为 README 的长度或嵌套结构而耗尽栈/CPU。

## 2. 本轮语料与结果

`tests/markdown.test.ts` 新增三组（r30-R2）：

- **确定性伪随机语料**：500 个长度 0–139 的字符串，字母表包含 `[]()!*:\`/<>"'#?&=.%_-`
  与制表/换行。对每棵树断言：节点类型在登记集合内；每个 `link.href` 都等于
  `isSafeHref(href)`；`href` 以 `http(s)://` 开头；内联深度 ≤ 34。
- **协议混淆**：NUL、垂直制表、制表/换行插在 scheme 中、HTML 实体（`&#106;`）、
  零宽字符、协议相对 URL、反斜杠 URL、`https:\u0000javascript:`。
- **指针串**：4,000 个 `*` + `x` + 4,000 个 `*`，以及 2,000 组 `*a`；解析必须结束、
  保留文本、深度受限。

结果：随机语料与混淆语料没有发现可执行的链接；深度检查通过。**发现并修复了一个真实缺陷**：

- 旧 `isSafeHref` 只校验 `^scheme:`，因此 `https:javascript:alert(1)` 被当作安全链接；
  它没有 `//` authority，不是浏览器意义上的 web 地址。空主机 `https://` 和控制字节
  也未被拒绝。
- 修复（`src/lib/markdown.ts`）：要求 `http://`/`https://` authority、拒绝 C0 控制字符、
  再用 `new URL()` 校验协议与主机；任一失败都退化为纯文本标签，URL 不进入节点树。
- 同时给内联递归加 `MAX_INLINE_DEPTH = 32`：超过深度的 body 作为文本保留，不再递归。
  这是防御性上限——本轮构造的指针串没有触发它，但 README 可以选择输入形状，解析器不能
  假设只收到手写文档。

## 3. 仍然存在/不承诺的部分

- 链接目标可以是钓鱼站点；白名单只保证协议是 http(s)，不判断域名信誉。渲染器不在应用内
  加载远端页面，点击走系统浏览器并经过 `lib/external-url.ts` 的同一白名单与 toast。
- 带 userinfo 的 `https://user:pass@host` 仍被接受：它是浏览器可打开的 https URL，凭据由
  README 作者写入，不是用户秘密。若未来要做反钓鱼提示，应作为 UI 提示而非解析器拒绝。
- 图片只保留 alt 文本，不保留 URL，也不会被加载；这是已有的结构性保证。
- 远端预览对话框读的是 GitHub 返回的 README 文本，仍受同一解析器约束；本轮没有做
  真机 GUI 截图验证。

## 4. 复现

```bash
node --experimental-strip-types --import ./tests/helpers/register.mjs \
  --test tests/markdown.test.ts
```

随机语料使用固定种子（`0x302e0a29`），每次运行生成相同 500 个用例；失败信息会打印出
具体输入与违规节点。

## 5. 来源

- CommonMark 规范（链接与图片语法、HTML 块）：<https://spec.commonmark.org/>
- WHATWG URL 标准（`https:` 无 authority 的解析）：<https://url.spec.whatwg.org/>
- OWASP XSS Prevention Cheat Sheet（URL 白名单、避免危险 scheme）：
  <https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html>
