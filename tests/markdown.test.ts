/**
 * `parseMarkdown` — the zero-dependency Markdown subset parser (round 17, n2-1).
 *
 * Two things this file has to prove, and they are not the same thing:
 *
 *   1. **It parses** the constructs a README uses (headings, paragraphs, lists
 *      with one nesting level, fenced code, quotes, rules, and the inline set).
 *   2. **It cannot emit HTML.** The parser's product is a tree of typed nodes
 *      with no `html` member and no serialiser, so README-authored markup has to
 *      arrive as text. The XSS vectors below are the ones a GitHub-hosted README
 *      can actually carry, plus the `javascript:`/`data:`/`vbscript:` link
 *      targets that must degrade to the link's visible text.
 *
 * Node native runner, `.ts` only — no JSX, no enum, no namespace (the runner
 * strips types, and `--experimental-strip-types` refuses the rest).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMarkdown, isSafeHref, type MdBlock, type MdInline } from "../src/lib/markdown.ts";

/** Every inline node's visible text, flattened (images show their alt). */
function inlineText(nodes: MdInline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.text;
        case "code":
          return n.text;
        case "image":
          return n.alt;
        case "strong":
        case "em":
          return inlineText(n.children);
        case "link":
          return inlineText(n.children);
      }
    })
    .join("");
}

/** Every inline node type reachable from a block list. */
function inlineTypes(blocks: MdBlock[]): string[] {
  const acc: string[] = [];
  const walk = (nodes: MdInline[]) => {
    for (const n of nodes) {
      acc.push(n.type);
      if (n.type === "strong" || n.type === "em" || n.type === "link") walk(n.children);
    }
  };
  const visit = (bs: MdBlock[]) => {
    for (const b of bs) {
      if (b.type === "heading" || b.type === "paragraph") walk(b.inline);
      else if (b.type === "quote") visit(b.blocks);
      else if (b.type === "table") {
        for (const cell of b.header) walk(cell);
        for (const row of b.rows) for (const cell of row) walk(cell);
      } else if (b.type === "list")
        for (const item of b.items) {
          walk(item.inline);
          for (const child of item.children) walk(child.inline);
        }
    }
  };
  visit(blocks);
  return acc;
}

/** The single block at `i`, asserted to exist — keeps the tests readable. */
function blockAt(blocks: MdBlock[], i: number): MdBlock {
  const b = blocks[i];
  assert.ok(b, `expected a block at index ${i}, document has ${blocks.length}`);
  return b;
}

// ---------------------------------------------------------------------------
// 1. Blocks

test("headings: # … ######, level counted, closing hashes dropped", () => {
  const blocks = parseMarkdown("# 一级\n\n### 三级 ##\n\n###### 六级\n\n####### 七个井号不是标题");
  assert.deepEqual(
    blocks.map((b) => (b.type === "heading" ? [b.level, inlineText(b.inline)] : null)),
    [[1, "一级"], [3, "三级"], [6, "六级"], null],
  );
  assert.equal(blockAt(blocks, 3).type, "paragraph", "seven hashes is body text, not a heading");
});

test("paragraphs: soft-wrapped lines join with a space, blank line splits them", () => {
  const blocks = parseMarkdown("第一行\n第二行\n\n第二段");
  assert.deepEqual(
    blocks.map((b) => (b.type === "paragraph" ? inlineText(b.inline) : b.type)),
    ["第一行 第二行", "第二段"],
  );
});

test("horizontal rule: --- / *** / ___ are rules, a lone bullet is not", () => {
  const blocks = parseMarkdown("---\n\n***\n\n_ _ _\n\n- 一项");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["hr", "hr", "hr", "list"],
  );
});

test("fenced code: lang captured, body verbatim", () => {
  const blocks = parseMarkdown("```rust\nfn main() {}\nlet x = 1;\n```\n");
  assert.deepEqual(blocks, [{ type: "code", lang: "rust", text: "fn main() {}\nlet x = 1;" }]);
});

test("fenced code: an unclosed fence runs to end of file, it is not silently dropped", () => {
  const blocks = parseMarkdown("```js\nconsole.log(1)\nlet a = 2");
  assert.deepEqual(blocks, [{ type: "code", lang: "js", text: "console.log(1)\nlet a = 2" }]);
});

test("block quotes: `>` stripped, content parsed as its own blocks", () => {
  const blocks = parseMarkdown("> 引用第一行\n> 引用第二行");
  const q = blockAt(blocks, 0);
  assert.equal(q.type, "quote");
  if (q.type !== "quote") return;
  const inner = blockAt(q.blocks, 0);
  assert.equal(inner.type, "paragraph");
  if (inner.type !== "paragraph") return;
  assert.equal(inlineText(inner.inline), "引用第一行 引用第二行");
});

test("lists: unordered with one nesting level; ordered detected by the marker", () => {
  const un = parseMarkdown("- 甲\n- 乙\n  - 乙的子项\n- 丙");
  assert.deepEqual(un, [
    {
      type: "list",
      ordered: false,
      items: [
        { inline: [{ type: "text", text: "甲" }], children: [] },
        { inline: [{ type: "text", text: "乙" }], children: [{ inline: [{ type: "text", text: "乙的子项" }], children: [] }] },
        { inline: [{ type: "text", text: "丙" }], children: [] },
      ],
    },
  ]);

  const ol = parseMarkdown("1. 一\n2. 二");
  const first = blockAt(ol, 0);
  assert.equal(first.type, "list");
  if (first.type !== "list") return;
  assert.equal(first.ordered, true);
  assert.equal(first.items.length, 2);
});

test("tables: header, alignment, escaped pipes, short rows and inline cells", () => {
  const blocks = parseMarkdown(
    "| Name | Value |\n| :--- | ---: |\n| a \\| b | **bold** |\n| short |",
  );
  const table = blockAt(blocks, 0);
  assert.equal(table.type, "table");
  if (table.type !== "table") return;
  assert.deepEqual(table.align, ["left", "right"]);
  assert.deepEqual(table.header.map(inlineText), ["Name", "Value"]);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0]?.map(inlineText), ["a | b", "bold"]);
  assert.deepEqual(table.rows[1]?.map(inlineText), ["short", ""], "a missing cell is padded, not a shifted row");
  assert.equal(table.rows[0]?.[1]?.[0]?.type, "strong");
});

test("tables: a delimiter of the wrong width is not a table", () => {
  const blocks = parseMarkdown("| a | b |\n| --- |\n");
  assert.equal(blockAt(blocks, 0).type, "paragraph");
});

test("task lists: markers are stripped and checked/unchecked are distinct", () => {
  const blocks = parseMarkdown("- [ ] todo\n- [x] done\n  - [X] nested");
  const list = blockAt(blocks, 0);
  assert.equal(list.type, "list");
  if (list.type !== "list") return;
  assert.equal(list.items[0]?.task, "unchecked");
  assert.equal(list.items[1]?.task, "checked");
  assert.equal(inlineText(list.items[0]?.inline ?? []), "todo");
  assert.equal(inlineText(list.items[1]?.inline ?? []), "done");
  assert.equal(list.items[1]?.children[0]?.task, "checked");
  assert.equal(inlineText(list.items[1]?.children[0]?.inline ?? []), "nested");
  // An ordered list keeps `[x]` as ordinary text, like GitHub.
  const ordered = parseMarkdown("1. [x] not a task");
  const first = blockAt(ordered, 0);
  assert.equal(first.type, "list");
  if (first.type !== "list") return;
  assert.equal(first.items[0]?.task, undefined);
  assert.equal(inlineText(first.items[0]?.inline ?? []), "[x] not a task");
});

// ---------------------------------------------------------------------------
// 2. Inline

test("inline: code, strong, em nest as typed nodes and keep their text", () => {
  const blocks = parseMarkdown("a `x = 1` b **粗** c *斜*");
  const p = blockAt(blocks, 0);
  assert.equal(p.type, "paragraph");
  if (p.type !== "paragraph") return;
  // Top-level node types: the emphasis wrappers nest a text child, which is not
  // a sibling — `inlineTypes` descends, this counts one level.
  assert.deepEqual(
    p.inline.map((n) => n.type),
    ["text", "code", "text", "strong", "text", "em"],
  );
  assert.equal(inlineText(p.inline), "a x = 1 b 粗 c 斜");
  // The wrappers really do carry the content as children, not as a flattened text.
  const strong = p.inline.find((n) => n.type === "strong");
  assert.deepEqual(strong && strong.type === "strong" ? strong.children : null, [{ type: "text", text: "粗" }]);
});

test("inline: a real http/https link becomes a link node with its href", () => {
  const blocks = parseMarkdown("见 [文档](https://example.com/d) 与 [站点](http://example.com)");
  const p = blockAt(blocks, 0);
  assert.equal(p.type, "paragraph");
  if (p.type !== "paragraph") return;
  const links = p.inline.filter((n) => n.type === "link");
  assert.deepEqual(
    links.map((n) => (n.type === "link" ? [n.href, inlineText(n.children)] : null)),
    [["https://example.com/d", "文档"], ["http://example.com", "站点"]],
  );
});

test("images: kept as alt-text placeholders, never as something to fetch", () => {
  const blocks = parseMarkdown("![构建状态](https://img.example/badge.svg)");
  assert.deepEqual(blocks, [
    { type: "paragraph", inline: [{ type: "image", alt: "构建状态" }] },
  ]);
  // No URL survives on the node: the parser cannot hand a remote asset to anyone.
  assert.equal(JSON.stringify(blocks).includes("img.example"), false);
});

// ---------------------------------------------------------------------------
// 3. The security model

test("raw HTML is text: <script>…</script> does not become a tag", () => {
  const src = "<script>alert(1)</script>";
  assert.deepEqual(parseMarkdown(src), [
    { type: "paragraph", inline: [{ type: "text", text: src }] },
  ]);
});

test("raw HTML with an event handler is text: <img src=x onerror=…>", () => {
  const src = "<img src=x onerror=alert(1)>";
  assert.deepEqual(parseMarkdown(src), [
    { type: "paragraph", inline: [{ type: "text", text: src }] },
  ]);
  assert.deepEqual(inlineTypes(parseMarkdown(src)), ["text"]);
});

test("dangerous link schemes degrade to the visible text (URL dropped)", () => {
  for (const target of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///C:/Windows",
    "  javascript:alert(1)  ",
  ]) {
    const blocks = parseMarkdown(`[点我](${target})`);
    assert.equal(
      inlineTypes(blocks).includes("link"),
      false,
      `${target} produced a link node — the whitelist leaked`,
    );
    const p = blockAt(blocks, 0);
    const text = p.type === "paragraph" ? inlineText(p.inline) : "";
    assert.ok(text.startsWith("点我"), `${target}: the visible label was lost (got "${text}")`);
    assert.equal(
      /javascript|vbscript|data:|file:/i.test(text),
      false,
      `${target}: the URL leaked into the text (got "${text}")`,
    );
  }
});

test("isSafeHref: only http/https, case-insensitively, brackets tolerated", () => {
  assert.equal(isSafeHref("https://a"), "https://a");
  assert.equal(isSafeHref("HTTPS://A"), "HTTPS://A");
  assert.equal(isSafeHref("http://a"), "http://a");
  assert.equal(isSafeHref("<https://a>"), "https://a");
  assert.equal(isSafeHref("javascript:alert(1)"), null);
  assert.equal(isSafeHref("JavaScript:alert(1)"), null);
  assert.equal(isSafeHref("data:text/html,x"), null);
  assert.equal(isSafeHref("vbscript:x"), null);
  // Scheme-less targets are refused too — the whitelist is a whitelist.
  assert.equal(isSafeHref("#anchor"), null);
  assert.equal(isSafeHref("./relative.md"), null);
  assert.equal(isSafeHref(""), null);
  // r30-R2: a scheme without an authority is not a web address. `https:foo`
  // and an empty host used to pass the old scheme-only check.
  assert.equal(isSafeHref("https:javascript:alert(1)"), null);
  assert.equal(isSafeHref("https://"), null);
  assert.equal(isSafeHref("https://\u0000javascript:alert(1)"), null);
  assert.equal(isSafeHref("https://example.com/\tpath"), null);
  assert.equal(isSafeHref("https://example.com/path"), "https://example.com/path");
});

test("no node type is ever an HTML carrier", () => {
  // The structural half of the claim: there is no `html` node and no serialiser,
  // so the renderer must build elements itself. Asserted over a document that
  // mixes every construct, including the vectors above.
  const blocks = parseMarkdown(
    "# 标题 <b>x</b>\n\n<img src=x onerror=alert(1)>\n\n- <script>alert(1)</script>\n\n> [x](javascript:0)\n\n```html\n<script>alert(1)</script>\n```\n",
  );
  const types = new Set<string>();
  for (const b of blocks) types.add(b.type);
  for (const t of inlineTypes(blocks)) types.add(t);
  assert.equal(types.has("html"), false, "an html carrier appeared in the node tree");
});

// ---------------------------------------------------------------------------
// 4. Robustness

test("a very long single line parses without truncation or hanging", () => {
  const line = "x".repeat(200_000);
  const blocks = parseMarkdown(line);
  const p = blockAt(blocks, 0);
  assert.equal(blocks.length, 1);
  assert.equal(p.type, "paragraph");
  if (p.type !== "paragraph") return;
  assert.equal(inlineText(p.inline).length, 200_000);
});

test("empty and whitespace-only input produce nothing", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("\n\n  \n"), []);
});

test("CRLF and lone CR both normalise, so Windows checkouts parse the same", () => {
  assert.deepEqual(parseMarkdown("a\r\nb"), parseMarkdown("a\nb"));
  assert.deepEqual(parseMarkdown("a\rb"), parseMarkdown("a\nb"));
});

// ---------------------------------------------------------------------------
// 5. Adversarial corpus (r30-R2)
//
// The parser is safe by construction (typed nodes, no HTML carrier, href
// whitelist). This section attacks the other property a document from the
// network can violate: it can be arbitrarily shaped. The invariant checked over
// every generated tree is the one the renderer depends on — every `link.href`
// is one `isSafeHref` would return — plus a depth bound and the absence of any
// unknown node type.

function maxInlineDepth(nodes: MdInline[], depth = 1): number {
  let max = depth;
  for (const node of nodes) {
    if (node.type === "strong" || node.type === "em" || node.type === "link") {
      max = Math.max(max, maxInlineDepth(node.children, depth + 1));
    }
  }
  return max;
}

function allInline(blocks: MdBlock[]): MdInline[] {
  const out: MdInline[] = [];
  const walk = (nodes: MdInline[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.type === "strong" || n.type === "em" || n.type === "link") walk(n.children);
    }
  };
  const visit = (bs: MdBlock[]) => {
    for (const b of bs) {
      if (b.type === "heading" || b.type === "paragraph") walk(b.inline);
      else if (b.type === "quote") visit(b.blocks);
      else if (b.type === "table") {
        for (const cell of b.header) walk(cell);
        for (const row of b.rows) for (const cell of row) walk(cell);
      } else if (b.type === "list")
        for (const item of b.items) {
          walk(item.inline);
          for (const child of item.children) walk(child.inline);
        }
    }
  };
  visit(blocks);
  return out;
}

test("adversarial: a pointer-run of emphasis cannot recurse without bound", () => {
  for (const src of [
    `${"*".repeat(4_000)}x${"*".repeat(4_000)}`,
    `${"*a".repeat(2_000)}${"*".repeat(2_000)}`,
    `${"[".repeat(2_000)}x${"]".repeat(2_000)}(https://example.com)`,
  ]) {
    const blocks = parseMarkdown(src);
    const inline = allInline(blocks);
    assert.ok(maxInlineDepth(inline) <= 34, `depth escaped the bound: ${maxInlineDepth(inline)}`);
    // The parser must finish and keep the text, not throw or drop the tail.
    assert.ok(inlineText(blocks.flatMap((b) => (b.type === "paragraph" ? b.inline : []))).length > 0);
  }
});

test("adversarial: link hrefs are always what the whitelist would return", () => {
  // Deterministic pseudo-random corpus: the alphabet includes the characters
  // that switch the inline scanner into a link, an image, emphasis or code.
  let seed = 0x30_2e_0a_29;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = "ab[]()!*:`:/\\\t\n <>\"'#?&=.%_-";
  for (let caseNo = 0; caseNo < 500; caseNo += 1) {
    const len = rand() % 140;
    let src = "";
    for (let i = 0; i < len; i += 1) src += alphabet[rand() % alphabet.length] ?? "a";
    const blocks = parseMarkdown(src);
    for (const node of allInline(blocks)) {
      assert.ok(
        ["text", "code", "strong", "em", "link", "image"].includes(node.type),
        `unknown node type ${node.type}`,
      );
      if (node.type === "link") {
        assert.equal(isSafeHref(node.href), node.href, `href escaped the whitelist: ${node.href}`);
        assert.match(node.href, /^https?:\/\//i);
      }
    }
    assert.ok(maxInlineDepth(allInline(blocks)) <= 34);
  }
});

test("adversarial: scheme obfuscation never becomes a link", () => {
  const targets = [
    "\u0000javascript:alert(1)",
    "\u000bjavascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "&#106;avascript:alert(1)",
    "jAvA\u200bscript:alert(1)",
    "//evil.example/x",
    "\\\\evil.example\\x",
    "https:\u0000javascript:alert(1)",
  ];
  for (const target of targets) {
    const blocks = parseMarkdown(`[label](${target})`);
    for (const node of allInline(blocks)) {
      if (node.type === "link") assert.match(node.href, /^https?:\/\//i);
    }
    // A safe `http(s)` scheme is allowed even if its path contains odd bytes;
    // the browser still receives an http(s) URL, not a script scheme.
    assert.ok(isSafeHref(target) === null || /^https?:/i.test(target.trim()));
  }
});
