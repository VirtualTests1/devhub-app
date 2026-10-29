/**
 * A zero-dependency Markdown subset parser (round 17, n2-1).
 *
 * ## Why a parser instead of a Markdown dependency
 *
 * The app has never had any Markdown rendering, and the one place that *shows*
 * Markdown today (添加页's remote README preview) says so out loud: 「Markdown
 * 原文，未渲染」. The feature this module exists for — reading a **local**
 * repository's README in-app — is worth rendering, but pulling in a real
 * Markdown library means a new runtime dependency whose transitive tree would
 * land in `package.json`, `pnpm-lock.yaml` and the supply-chain guard for a
 * single dialog. So this is a deliberately small subset: the constructs a
 * README actually uses, and nothing else.
 *
 * ## The security model: this module NEVER produces an HTML string
 *
 * The parser's only product is a tree of structured nodes. There is no
 * `html:` field, no serialiser, and therefore no `dangerouslySetInnerHTML` at
 * the call site — the React renderer maps `{type: "heading"}` to `<h2>` itself.
 * That is the whole defence against README-authored HTML: `<script>alert(1)
 * </script>` is not a tag here, it is the text nodes `<`, `s`, `c`, … falling
 * through the scanner, and it lands on screen as the literal text it is.
 *
 * The second half of that model is the URL whitelist. A Markdown link is the
 * one construct that reaches the browser as a navigable target, so
 * [`isSafeHref`] admits only `http:` / `https:`. Everything else — including
 * the obvious `javascript:` / `data:` / `vbscript:` vectors and, conservatively,
 * scheme-less relative paths and `#anchors` — degrades to the link's **visible
 * text** kept as plain text, with the URL dropped rather than rendered. The
 * caller therefore never receives a `link` node whose `href` it would have to
 * re-validate.
 *
 * ## Scope (what it does and does not parse)
 *
 * In: ATX headings (`#`…`######`), paragraphs, unordered/ordered lists (one
 * nesting level), fenced code blocks (```lang), block quotes, horizontal rules,
 * and the inline set code / strong / em / link / image.
 *
 * Out, on purpose: reference links, tables, HTML blocks, footnotes, task
 * lists, setext headings, autolinks. A construct that is not recognised is not
 * swallowed — it renders as the plain text it was written as.
 *
 * Image syntax is parsed but **not loaded**: an image becomes an `image` node
 * carrying only its alt text, because a README's images point at remote URLs
 * (shields, badges, screenshots) and this app never fetches a remote asset from
 * a document it is merely displaying.
 */

export type MdInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "link"; href: string; children: MdInline[] }
  /** Alt text only — see the module note: no URL is kept, nothing is fetched. */
  | { type: "image"; alt: string };

export type MdListItem = {
  inline: MdInline[];
  /** One nesting level deeper, per the scope above. */
  children: MdListItem[];
};

export type MdBlock =
  | { type: "heading"; level: number; inline: MdInline[] }
  | { type: "paragraph"; inline: MdInline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; blocks: MdBlock[] }
  | { type: "list"; ordered: boolean; items: MdListItem[] }
  | { type: "hr" };

/**
 * A URL is admitted only with an explicit `http:` / `https:` scheme.
 *
 * Exported because the renderer and the tests both need the same rule, and a
 * second copy of "which schemes are safe" is exactly the kind of duplicate
 * that drifts apart (the repo's `single-source` guard exists for that failure).
 * Returns the trimmed URL when it is safe, `null` otherwise.
 */
export function isSafeHref(raw: string): string | null {
  let url = raw.trim();
  // CommonMark allows `<https://…>`; the angle brackets are delimiters, not part
  // of the URL.
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1).trim();
  // Require the authority marker, not just a scheme. `https:javascript:…` has an
  // `https` scheme but no `//`, which the URL parser treats as an opaque path
  // rather than a web address; accepting it would let the row show a link that
  // is not the http(s) document the whitelist promises. r30-R2 found this with
  // the adversarial corpus.
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url);
  if (!m) return null;
  const scheme = m[1]?.toLowerCase() ?? "";
  if (scheme !== "http" && scheme !== "https") return null;
  // A control byte has no place in a URL a person is about to open. Some URL
  // parsers strip tab/newline silently; refusing here keeps the rendered target
  // and the opened target the same string.
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return null;
    }
  } catch {
    return null;
  }
  return url;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const HEADING = /^(#{1,6})(?:[ \t]+(.*))?$/;
const HR = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^\s{0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

/** Is this line the start of a block that interrupts a paragraph? */
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

/** Parse a whole document. `src` may use any of CRLF / CR / LF. */
export function parseMarkdown(src: string): MdBlock[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code — an unclosed fence runs to the end of the document, which is
    // what every Markdown renderer does; it must not silently drop the tail.
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]?.[0] ?? "`";
      const min = fence[1]?.length ?? 1;
      // The info string's first word is the language; `{.js}` is an uncommon
      // spelling this subset normalises to `js` rather than showing verbatim.
      let lang = fence[2]?.trim().split(/[ \t]+/)[0] ?? "";
      if (lang.startsWith("{.")) lang = lang.slice(2);
      else if (lang.startsWith("{")) lang = lang.slice(1);
      if (lang.endsWith("}")) lang = lang.slice(0, -1);
      const close = new RegExp(`^\\s{0,3}${marker === "`" ? "`" : "~"}{${min},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    // Horizontal rule is checked before a bullet so a line of `- - -` (a rule)
    // is not read as a list item whose text is `- -`.
    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      // Trailing hashtags are a closing sequence, not content (`# Title ##`).
      const content = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      blocks.push({ type: "heading", level, inline: parseInline(content) });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i] ?? "");
        if (!q) break;
        inner.push(q[1] ?? "");
        i++;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const baseIndent = item[1]?.length ?? 0;
      const ordered = /^\d/.test(item[2] ?? "");
      const items: MdListItem[] = [];
      while (i < lines.length) {
        const li = LIST_ITEM.exec(lines[i] ?? "");
        if (!li) break;
        const indent = li[1]?.length ?? 0;
        if (indent < baseIndent) break;
        const node: MdListItem = { inline: parseInline(li[3] ?? ""), children: [] };
        const prev = indent >= baseIndent + 2 ? items[items.length - 1] : undefined;
        if (prev) {
          // One indentation step deeper → a child of the item above.
          prev.children.push(node);
        } else {
          items.push(node);
        }
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive lines up to a blank line or the start of any block.
    // Soft line breaks become a single space, as in every Markdown renderer.
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      if (cur.trim() === "" || startsBlock(cur)) break;
      para.push(cur.trim());
      i++;
    }
    blocks.push({ type: "paragraph", inline: parseInline(para.join(" ")) });
  }
  return blocks;
}

/**
 * Inline scanner. Every character that is not part of a recognised construct is
 * appended to a text buffer — that is why raw HTML and unknown syntax survive as
 * literal text rather than disappearing.
 *
 * ## Depth bound (r30-R2)
 *
 * Strong/em/link nodes carry children, and each wrapper recursively parses its
 * own body. A README can therefore choose the nesting depth: a long run of
 * asterisks (`"*".repeat(n) + "x" + "*".repeat(n)`) is enough to recurse until
 * the webview's stack gives out while merely opening a read-only preview. The
 * parser cannot know whether a document is 12 levels of emphasis or a denial of
 * service, so it stops descending at [`MAX_INLINE_DEPTH`] and keeps the rest of
 * that body as literal text: the preview stays readable and no input can turn
 * into unbounded recursion.
 */
const MAX_INLINE_DEPTH = 32;

function parseInline(text: string, depth = 0): MdInline[] {
  if (depth > MAX_INLINE_DEPTH) return [{ type: "text", text }];
  const out: MdInline[] = [];
  let buf = "";
  const flush = () => {
    if (buf !== "") {
      out.push({ type: "text", text: buf });
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ type: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    if (ch === "!" && text[i + 1] === "[") {
      const img = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(i));
      if (img) {
        flush();
        out.push({ type: "image", alt: img[1] ?? "" });
        i += img[0]?.length ?? 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    if (ch === "[") {
      const link = /^\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(i));
      if (link) {
        flush();
        const href = isSafeHref(link[2] ?? "");
        if (href) out.push({ type: "link", href, children: parseInline(link[1] ?? "", depth + 1) });
        // Degrade: keep the label as plain text, drop the URL entirely, so a
        // `javascript:` target can never reach a renderer as a link node.
        else out.push(...parseInline(link[1] ?? "", depth + 1));
        i += link[0]?.length ?? 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i) {
        flush();
        out.push({ type: "strong", children: parseInline(text.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
      buf += "**";
      i += 2;
      continue;
    }

    if (ch === "*") {
      const end = text.indexOf("*", i + 1);
      // `end > i + 1` refuses an empty `**` and a run of bare asterisks.
      if (end > i + 1) {
        flush();
        out.push({ type: "em", children: parseInline(text.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return coalesce(out);
}

/** Merge adjacent text nodes so `a` + `)` reads as one node, not two. */
function coalesce(nodes: MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const node of nodes) {
    if (node.type === "text" && node.text === "") continue;
    const last = out[out.length - 1];
    if (node.type === "text" && last && last.type === "text") {
      out[out.length - 1] = { type: "text", text: last.text + node.text };
    } else {
      out.push(node);
    }
  }
  return out;
}
