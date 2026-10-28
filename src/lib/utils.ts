/**
 * `cn()` — the className helper every component routes through.
 *
 * ## Why this file no longer imports `clsx` + `tailwind-merge` (r21-o1, O1-3)
 *
 * Together they were 27564 B of shipped JavaScript for one 6-line function
 * (`vendor-tailwind-merge` 27283 B + `vendor-clsx` 410 B, `node scripts/bundle-atlas.mjs`
 * measured 2026-10-19 — the report's older "6.3%" came from a bundle-atlas that read
 * the wrong sourcemap field; the corrected figure is 3.0% of attributed bytes).
 * Both are now implemented here: `toClasses` keeps clsx's accept/reject rules, and
 * `cn()` reproduces what `twMerge` did to the class strings this repository actually
 * passes to it.
 *
 * ## What "reproduces" is pinned to — and its honest limit
 *
 * The merge contract is measured, not guessed. On 2026-10-19 a differential run
 * compared `twMerge(clsx(x))` (tailwind-merge 3.x, the package being removed) against
 * this implementation over three corpora, all from this checkout:
 *   1. every runtime-reachable variant combination of the 118 `cn(...)` call sites in
 *      `src/` — each `cond ? "a" : "b"` / `cond && "x"` branch enumerated as its own
 *      input: 4341 combos, **0 differences**;
 *   2. every ordered pair of the 403 class tokens that reach `cn()`: 162409 pairs,
 *      **0 differences**;
 *   3. every ordered pair of the 3458-token class vocabulary of all of `src/` (this
 *      catches the values that arrive through identifier arguments — `map[status]`,
 *      `toneClass`, `SEVERITY_TONE[…]`): 11957764 pairs, **0 differences**;
 *   plus 200000 random 3-token combinations, **0 differences**.
 * `tests/utils-cn.test.ts` pins the same contract from the outside (`p-2`/`p-4`,
 * `px` vs `py`, `text-sm`/`text-lg`, `grid-cols`, arbitrary `w-[…]` values).
 *
 * The limit: equivalence is established over this repository's class vocabulary.
 * A class group this table does not model (or models differently from tailwind-merge)
 * would merge differently **only for code written after this change** — no shipped
 * call site depends on it, and the three differentials above are the check to re-run
 * when a new group starts appearing (they need tailwind-merge installed, so they live
 * in the commit record rather than in `tests/`).
 *
 * One quirk is deliberately **preserved rather than fixed**: tailwind-merge does not
 * know this app's custom font-size tokens (`text-caption`, `text-body`, `text-view`,
 * `text-display`, `text-mono`) and classifies them as *text colours*, so today
 * `cn("… text-caption", cond && "text-foreground")` silently drops `text-caption`.
 * ~40 call sites ship that behaviour right now. "Fixing" it here would change how
 * those elements render — a UI change nobody has verified on a real machine — so
 * `groupOf` reproduces the classification instead; the measured list is in the
 * commit message of feat(o1-3).
 */

/** What `cn()` accepts — clsx's `ClassValue`, restated so the dep can go. */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | boolean
  | ClassValue[]
  | { [key: string]: unknown };

/** clsx's rules: strings/numbers pass, arrays flatten, objects keep truthy keys. */
function toClasses(value: ClassValue, out: string[]): void {
  if (typeof value === "string") {
    if (value) out.push(value);
  } else if (typeof value === "number") {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) toClasses(item, out);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (value[key]) out.push(key);
    }
  }
  // null / undefined / false / "" contribute nothing
}

/**
 * `[group, pattern]` pairs, tried in order (specific before generic) against the
 * utility **after** `variant:` prefixes are split off. No match ⇒ the token is not
 * a recognised utility and is left alone forever, exactly like tailwind-merge
 * leaves classes it cannot classify (`t-state`, `skin-ctl`, `strip.*`, …; probed:
 * `twMerge("t-state t-state")` keeps both).
 */
const GROUP_RULES: Array<[string, RegExp]> = [
  ["display", /^(?:-)?(?:(?:inline|flow(?:-root)?)-)?(?:block|flex|grid|table|inline|contents|list-item)$/],
  ["display", /^hidden$/],
  ["flex-size", /^flex-(?:\d+|auto|none|\[)/],
  ["flex-dir", /^flex-(?:row|col)(?:-\d+|-\[)?(?:-reverse)?$/],
  ["flex-wrap", /^flex-(?:wrap|nowrap|wrap-reverse)$/],
  ["flex-grow", /^grow(?:-\d+|-\[)?$/],
  ["flex-shrink", /^shrink(?:-\d+|-\[)?$/],
  ["grid-cols", /^grid-cols-/],
  ["grid-rows", /^grid-rows-/],
  ["auto-cols", /^auto-cols-/],
  ["auto-rows", /^auto-rows-/],
  ["col-span", /^col-span-/],
  ["row-span", /^row-span-/],
  ["col-start", /^col-start-/],
  ["col-end", /^col-end-/],
  ["row-start", /^row-start-/],
  ["row-end", /^row-end-/],
  ["order", /^order-/],
  ["place-items", /^place-items-/],
  ["place-content", /^place-content-/],
  ["place-self", /^place-self-/],
  // the exclusion must not require the trailing dash: bare `justify-self` /
  // `justify-items` are unknown to tailwind-merge too (probed: they survive next to
  // `justify-center` AND dedupe against themselves).
  ["justify-self", /^justify-self-/],
  ["justify-items", /^justify-items-/],
  ["justify", /^justify-(?!self|items)/],
  ["items", /^items-/],
  ["align-content", /^content-/],
  // a value must follow: bare `gap-x`/`inset-x` are not classes and tailwind-merge
  // leaves them alone (probed), so the generic rule must not swallow them.
  ["gap-x", /^-?gap-x-(?:\d|px|\[)/],
  ["gap-y", /^-?gap-y-(?:\d|px|\[)/],
  ["gap", /^-?gap-(?:\d|px|\[)/],
  ["space-x", /^space-x-/],
  ["space-y", /^space-y-/],
  // divide splits into style / x / y / colour (probed: `divide-x-2 divide-border` and
  // `divide-y-2 divide-dashed` both keep BOTH).
  ["divide-style", /^divide-(?:solid|dashed|dotted|double|none)$/],
  ["divide-x", /^divide-x(?:-(?:\d|px|\[))?$/],
  ["divide-y", /^divide-y(?:-(?:\d|px|\[))?$/],
  ["divide", /^divide-/],
  // Value-anchored rules: a token like `p-x` / `w-x` / `right-click` (prose, not a
  // utility) must stay unrecognised — probed `p-x p-2`, `w-x w-2`, `right-click right-2`
  // all keep BOTH, i.e. tailwind-merge does not classify them.
  ["px", /^-?px-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["py", /^-?py-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["pt", /^-?pt-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["pr", /^-?pr-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["pb", /^-?pb-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["pl", /^-?pl-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["p", /^-?p-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["mx", /^-?mx-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["my", /^-?my-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["mt", /^-?mt-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["mr", /^-?mr-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["mb", /^-?mb-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["ml", /^-?ml-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["m", /^-?m-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  // scroll margins/paddings: one group per side, same shape as `m`/`p`
  // (probed: `scroll-mt-3 scroll-mt-4` merges; `scroll-mt-3 scroll-mb-2` and
  // `scroll-mt-3 scroll-mx-2` do not).
  ["scroll-mt", /^scroll-mt-/],
  ["scroll-mr", /^scroll-mr-/],
  ["scroll-mb", /^scroll-mb-/],
  ["scroll-ml", /^scroll-ml-/],
  ["scroll-mx", /^scroll-mx-/],
  ["scroll-my", /^scroll-my-/],
  ["scroll-pt", /^scroll-pt-/],
  ["scroll-pr", /^scroll-pr-/],
  ["scroll-pb", /^scroll-pb-/],
  ["scroll-pl", /^scroll-pl-/],
  ["scroll-px", /^scroll-px-/],
  ["scroll-py", /^scroll-py-/],
  // min/max width & height accept the named scale too (probed: `max-w-3xl max-w-md`
  // merges); `max-w-prose` is a real Tailwind size and joins the same group.
  ["min-w", /^-?min-w-(?:\d|\[|auto|full|screen|min|max|fit|px|sm|md|lg|xl|\dxl)/],
  ["max-w", /^-?max-w-(?:\d|\[|auto|full|screen|min|max|fit|px|sm|md|lg|xl|\dxl|prose)/],
  ["min-h", /^-?min-h-(?:\d|\[|auto|full|screen|min|max|fit|px|sm|md|lg|xl|\dxl)/],
  ["max-h", /^-?max-h-(?:\d|\[|auto|full|screen|min|max|fit|px|sm|md|lg|xl|\dxl)/],
  ["w", /^-?w-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["h", /^-?h-(?:\d|\[|auto|full|screen|min|max|fit|px)/],
  ["size", /^size-/],
  ["aspect", /^aspect-/],
  ["overflow-x", /^-?overflow-x-(?:auto|hidden|visible|clip|scroll)/],
  ["overflow-y", /^-?overflow-y-(?:auto|hidden|visible|clip|scroll)/],
  ["overflow", /^-?overflow-(?:auto|hidden|visible|clip|scroll)/],
  ["whitespace", /^whitespace-/],
  ["break", /^break-/],
  ["hyphens", /^hyphens-/],
  ["position", /^(?:static|fixed|absolute|relative|sticky)$/],
  ["inset-x", /^-?inset-x-/],
  ["inset-y", /^-?inset-y-/],
  ["inset", /^-?inset-(?:\d|px|\[|auto|full|min|max)/],
  ["top", /^-?top-(?:\d|\[|auto|full|screen|min|max|fit)/],
  ["right", /^-?right-(?:\d|\[|auto|full|screen|min|max|fit)/],
  ["bottom", /^-?bottom-(?:\d|\[|auto|full|screen|min|max|fit)/],
  ["left", /^-?left-(?:\d|\[|auto|full|screen|min|max|fit)/],
  ["z", /^-?z-(?:\d|\[)/],
  ["float", /^float-/],
  ["clear", /^clear-/],
  ["isolation", /^(?:isolate|isolation-\w+)$/],
  // probed: visible/invisible/collapse are one group (both orders merge), while
  // `tabular-nums ordinal` survives — ordinal is NOT in the numeric group.
  ["visibility", /^(?:visible|invisible|collapse)$/],
  ["numeric", /^(?:tabular-nums|normal-nums)$/],
  ["ordinal", /^ordinal$/],
  ["object", /^object-/],
  [
    "bg-image",
    /^bg-(?:cover|contain|fixed|local|scroll|repeat|no-repeat|repeat-[xy]|clip|gradient|linear|radial|url|position|center|top|bottom|left|right)(?:-|\[|$)/,
  ],
  ["bg", /^bg-/],
  ["from", /^from-/],
  ["via", /^via-/],
  ["to", /^to-/],
  ["border-style", /^border-(?:solid|dashed|dotted|double|none|hidden)$/],
  // `border-t` and `border-t-2` are ONE group (both orders merge, probed); the four
  // sides are four groups (`border-t border-r` survives, probed); bare/numbered
  // `border` kills the side widths when it comes later (`border-t border-2` → `border-2`).
  ["bw-t", /^border-t(?:-(?:\d+|px|\[[^\]]*\]))?$/],
  ["bw-r", /^border-r(?:-(?:\d+|px|\[[^\]]*\]))?$/],
  ["bw-b", /^border-b(?:-(?:\d+|px|\[[^\]]*\]))?$/],
  ["bw-l", /^border-l(?:-(?:\d+|px|\[[^\]]*\]))?$/],
  ["bw", /^border(?:-(?:\d+|px|\[[^\]]*\]))?$/],
  ["bc-t", /^border-t-/],
  ["bc-r", /^border-r-/],
  ["bc-b", /^border-b-/],
  ["bc-l", /^border-l-/],
  ["bc", /^border-/],
  // Corner radii are their own groups (probed: `rounded-md rounded-l-lg` keeps
  // both), while a later all-corners `rounded` kills every corner/side group and a
  // later side kills its corners — all four sides probed in both orders. The value
  // is optional because the bare side/corner form is a class too (probed:
  // `rounded-l-lg rounded-l` → `rounded-l`, `rounded-tl rounded-md` → `rounded-md`).
  ["rounded-tl", /^-?rounded-tl(?:-(?:sm|md|lg|xl|\dxl|full|none|\d+|px|\[[^\]]*\]))?$/],
  ["rounded-tr", /^-?rounded-tr(?:-(?:sm|md|lg|xl|\dxl|full|none|\d+|px|\[[^\]]*\]))?$/],
  ["rounded-bl", /^-?rounded-bl(?:-(?:sm|md|lg|xl|\dxl|full|none|\d+|px|\[[^\]]*\]))?$/],
  ["rounded-br", /^-?rounded-br(?:-(?:sm|md|lg|xl|\dxl|full|none|\d+|px|\[[^\]]*\]))?$/],
  ["rounded-t", /^-?rounded-t(?:-(?:sm|md|lg|xl|\dxl|full|none|\d+|px|\[[^\]]*\]))?$/],
  ["rounded-r", /^-?rounded-r(?:-(?:sm|md|lg|xl|\dxl|full|none|\d+|px|\[[^\]]*\]))?$/],
  ["rounded-b", /^-?rounded-b(?:-(?:sm|md|lg|xl|\dxl|full|none|\d+|px|\[[^\]]*\]))?$/],
  ["rounded-l", /^-?rounded-l(?:-(?:sm|md|lg|xl|\dxl|full|none|\d+|px|\[[^\]]*\]))?$/],
  ["rounded", /^-?rounded(?:-(?:sm|md|lg|xl|\dxl|full|none|\d+|px|\[[^\]]*\]))?$/],
  // `shadow-[var(--x)]` is NOT classified by tailwind-merge (probed: it survives
  // next to `shadow-lg` and next to another arbitrary shadow) — keep the bracket
  // value rule away from `var(`. Its group sits BEFORE the general rule because
  // `shadow-var` (this file's own group-name literal, which the whole-src scan picks
  // up) must land there too: probed both orders, tailwind-merge merges the two.
  ["shadow-var", /^shadow-\[var\(|^shadow-var$/],
  ["shadow", /^shadow(?:$|-(?!(?:\[)?var\b))/],
  // `ring-2 ring-ring` must NOT merge (probed): the bare `ring` alternative has to
  // be end-anchored, otherwise `ring-ring` matches it as a prefix.
  ["ring-width", /^ring$|^ring-(?:\d+|px|\[[^\]]*\])$/],
  ["ring-offset-width", /^ring-offset$|^ring-offset-(?:\d+|px|\[[^\]]*\])$/],
  ["ring-offset-color", /^ring-offset-/],
  ["ring-color", /^ring-/],
  // `outline-none` is its own group: probed `outline-none outline-2` keeps both.
  ["outline-none", /^outline-(?:none|hidden)$/],
  ["outline", /^outline$|^outline-(?:\d+|px|\[[^\]]*\])$/],
  ["outline-color", /^outline-/],
  ["opacity", /^opacity-/],
  ["cursor", /^cursor-/],
  ["select", /^select-/],
  ["resize", /^(?:resize|resize-[xy])$/],
  ["pointer-events", /^pointer-events-/],
  ["touch", /^touch-/],
  // only the real values: `appearance-group-size` (prose) must stay unknown.
  ["appearance", /^appearance-(?:auto|none|textfield|menulist|button|list|searchfield|field)$/],
  // `transition` and `transition-[width,…]` are one group (probed) — keep the rule
  // open-ended instead of enumerating modifiers that arbitrary values would dodge.
  ["transition", /^transition(?:$|-)/],
  ["duration", /^duration-/],
  ["delay", /^delay-/],
  ["ease", /^ease-/],
  ["animate", /^animate-/],
  ["rotate", /^-?rotate-/],
  ["translate-x", /^-?translate-x-/],
  ["translate-y", /^-?translate-y-/],
  ["scale", /^-?scale-/],
  ["skew-x", /^-?skew-x-/],
  ["skew-y", /^-?skew-y-/],
  ["origin", /^origin-/],
  ["backdrop", /^backdrop-/],
  ["blur", /^blur(?:-|\[|$)/],
  ["filter", /^filter$/],
  ["filter-modifier", /^(?:brightness|contrast|drop-shadow|grayscale|invert|saturate|sepia|hue-rotate)-/],
  // weights are their own group; every other `font-…` falls into the family group,
  // which is what makes the non-class token `font-weight` kill `font-mono` when
  // probed — the same any-value fallback the `text-*` rule documents above.
  ["font-weight", /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/],
  ["font-family", /^font-/],
  ["text-decoration-line", /^(?:underline|no-underline|line-through|overline)$/],
  ["leading", /^leading-/],
  ["tracking", /^tracking-/],
  ["indent", /^indent-/],
  // align-self and vertical-align are different groups (probed:
  // `self-center align-middle` keeps both) — `self-center self-start` merges.
  ["align-self", /^self-(?:auto|start|end|center|stretch|baseline)$/],
  ["vertical-align", /^align-(?:baseline|top|middle|bottom|text-top|text-bottom)$/],
  ["list", /^list-/],
  ["columns", /^columns-/],
  ["sr", /^(?:not-)?sr-only$/],
  ["mix-blend", /^mix-blend-/],
  ["will-change", /^will-change-/],
  ["caret", /^caret-/],
  ["accent", /^accent-/],
  ["fill", /^fill-/],
  ["stroke", /^stroke-/],
  ["decoration", /^decoration-/],
  ["underline-offset", /^underline-offset-/],
  ["placeholder", /^placeholder-/],
  ["line-clamp", /^line-clamp-/],
];

/**
 * Classify one utility (no variants) into a merge group, or `null` when it is not
 * one tailwind-merge would recognise either.
 *
 * The `text-*` split is what defines this file's contract (see the header): sizes
 * the library knows (T-shirt sizes, arbitrary lengths) form a font-size group,
 * **every other** `text-…` falls into one colour group — which is why the custom
 * `text-caption`/`text-body`/`text-view`/`text-display`/`text-mono` tokens collide
 * with `text-foreground` and friends today. `text-ellipsis`/`text-clip`/
 * `text-nowrap` are their own groups (probed: they do NOT conflict with
 * `text-caption`).
 */
function groupOf(base: string): string | null {
  if (base.startsWith("text-")) {
    const rest = base.slice(5);
    if (/^(?:xs|sm|base|lg|xl|\dxl)$/.test(rest)) return "text-size";
    if (rest.startsWith("[") && !/^\[(?:#|rgb|hsl|oklch|lab|var\(|theme|color-|currentColor)/i.test(rest)) {
      return "text-size"; // text-[14px] is a size; text-[#fff] is a colour
    }
    if (rest === "ellipsis" || rest === "clip") return "text-overflow";
    if (rest === "nowrap" || rest === "wrap" || rest === "balance" || rest === "pretty") return "text-wrap";
    // text-align is its own group: probed `text-caption text-left` keeps both,
    // while `text-left text-center` merges.
    if (rest === "left" || rest === "center" || rest === "right" || rest === "justify") return "text-align";
    return "text-color";
  }
  if (base === "truncate") return "text-overflow";
  for (const rule of GROUP_RULES) {
    if (rule[1].test(base)) return rule[0];
  }
  return null;
}

/**
 * A token split into the parts the merge decision needs:
 *   - `scope` — variant prefixes plus `!important` markers. Two tokens only
 *     override each other when these are identical (probed: `hover:p-1 p-2` and
 *     `px-2! p-1` both survive; `!p-4 p-2` keeps both).
 *   - `group` — the utility's class group, or `null` when it is not a utility
 *     tailwind-merge recognises either (`t-state`, `skin-ctl`, `strip.*`, `button`).
 */
function parseToken(token: string): { scope: string; group: string | null } {
  let rest = token;
  let important = "";
  if (rest.startsWith("!")) {
    important = "!";
    rest = rest.slice(1);
  }
  if (rest.endsWith("!")) {
    important += "!";
    rest = rest.slice(0, -1);
  }
  // Variant split at the last `:` outside `[...]` so `data-[state=open]:x` keeps it.
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ":" && depth === 0) cut = i;
  }
  const scope = important + (cut >= 0 ? rest.slice(0, cut + 1) : "");
  const base = cut >= 0 ? rest.slice(cut + 1) : rest;
  return { scope, group: groupOf(base) };
}

/**
 * Asymmetric overrides — every entry probed against tailwind-merge 3.x, because the
 * asymmetry is real and is half of what `cn()` callers already rely on:
 *
 *   `px-2 p-1` → `p-1`   but   `p-1 px-2` keeps both
 *   `left-1 inset-0` → `inset-0`   but   `inset-0 left-1` keeps both
 *   `shrink-0 flex-1` → `flex-1`   but   `flex-1 shrink-0` keeps both
 *
 * A later token of group G removes earlier tokens of group K when `K === G` or
 * `K ∈ KILLS[G]`. Only relations that were probed are listed; an unlisted pair
 * stays side by side, which is the conservative direction (nothing disappears).
 */
const KILLS: Record<string, readonly string[]> = {
  p: ["px", "py", "pt", "pr", "pb", "pl"],
  px: ["pl", "pr"],
  py: ["pt", "pb"],
  m: ["mx", "my", "mt", "mr", "mb", "ml"],
  mx: ["ml", "mr"],
  my: ["mt", "mb"],
  gap: ["gap-x", "gap-y"],
  bw: ["bw-t", "bw-r", "bw-b", "bw-l"],
  inset: ["inset-x", "inset-y", "top", "right", "bottom", "left"],
  // probed: `left-1 inset-x-0` → `inset-x-0`, reverse keeps both; same for y/top.
  "inset-x": ["left", "right"],
  "inset-y": ["top", "bottom"],
  overflow: ["overflow-x", "overflow-y"],
  "flex-size": ["flex-shrink", "flex-grow"],
  // probed, round 2 — each verified in both orders:
  //   `rounded-l-lg rounded-md` → `rounded-md`, reverse keeps both
  //   `rounded-tl-lg rounded-t-xl` → `rounded-t-xl`, reverse keeps both
  //   `flex line-clamp-2` → `line-clamp-2`, reverse keeps both
  //   `overflow-hidden line-clamp-2` → `line-clamp-2` (but overflow-x/y are NOT
  //   killed: `line-clamp-2 overflow-x-auto` keeps both, probed)
  //   `leading-relaxed text-sm` → `text-sm`, reverse keeps both
  rounded: ["rounded-t", "rounded-r", "rounded-b", "rounded-l", "rounded-tl", "rounded-tr", "rounded-bl", "rounded-br"],
  "rounded-t": ["rounded-tl", "rounded-tr"],
  "rounded-r": ["rounded-tr", "rounded-br"],
  "rounded-b": ["rounded-bl", "rounded-br"],
  "rounded-l": ["rounded-tl", "rounded-bl"],
  "line-clamp": ["display", "overflow"],
  "text-size": ["leading"],
};

/**
 * shadcn/ui's `cn()`: conditional classes + Tailwind conflict merging, now
 * dependency-free — `clsx`'s accept rules in `toClasses`, `tailwind-merge`'s
 * group/override semantics in `parseToken` + `KILLS`.
 */
export function cn(...inputs: ClassValue[]): string {
  const parts: string[] = [];
  for (const input of inputs) toClasses(input, parts);
  if (!parts.length) return "";
  const flat: string[] = [];
  for (const part of parts) {
    // /\s+/ rather than " ": tailwind-merge normalises whitespace when it rejoins
    // (a newline inside an argument came back as a single space when probed).
    for (const token of part.split(/\s+/)) if (token) flat.push(token);
  }
  const parsed = flat.map((token) => parseToken(token));
  const out: string[] = [];
  for (let i = 0; i < flat.length; i++) {
    const token = flat[i] ?? "";
    const cur = parsed[i] ?? { scope: "", group: null };
    if (cur.group === null) {
      // Unrecognised utility: tailwind-merge never removes it, duplicates included.
      out.push(token);
      continue;
    }
    let overridden = false;
    for (let j = i + 1; j < flat.length && !overridden; j++) {
      const next = parsed[j] ?? { scope: "", group: null };
      if (next.group === null || next.scope !== cur.scope) continue;
      if (next.group === cur.group) overridden = true;
      else if ((KILLS[next.group] ?? []).includes(cur.group)) overridden = true;
    }
    if (!overridden) out.push(token);
  }
  return out.join(" ");
}

/**
 * `owner/repo` out of anything that points at a GitHub repository (round 11,
 * 需求 8.8).
 *
 * The 添加页 search box used to treat a pasted URL as a *query*: GitHub's
 * search then looked for the literal string "https://github.com/rust-lang/rust"
 * and found nothing useful, while the composer right above it would have
 * accepted the same URL happily. Pasting a link is the most natural way to
 * arrive at "download this", so the search box now recognises it and hands
 * the composer what it parsed.
 *
 * Returns `null` for anything that is not a repository URL - a plain keyword,
 * a URL with no owner/repo pair, or a non-GitHub host. Being wrong here is
 * worse than being strict: a false positive would send a legitimate search
 * query into the download box.
 *
 * Accepted shapes (measured against what people actually paste):
 *
 *   https://github.com/rust-lang/rust
 *   http://github.com/rust-lang/rust
 *   github.com/rust-lang/rust
 *   www.github.com/rust-lang/rust
 *   https://github.com/rust-lang/rust.git
 *   https://github.com/rust-lang/rust/tree/main/src
 *   https://github.com/rust-lang/rust/issues/123#issuecomment-1
 */
export function parseGithubRepoUrl(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  // Anchor the host so `evil.com/github.com/a/b` cannot pass by containing the
  // host later in the string.
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/.exec(
    t,
  );
  if (!m) return null;
  const [, owner, repo] = m;
  // GitHub reserves these path prefixes; `github.com/settings/profile` is not
  // a repository and must not become one.
  if (!owner || !repo) return null;
  const reserved = ["settings", "notifications", "explore", "topics", "collections", "events", "sponsors", "orgs", "users", "features", "marketplace", "pricing", "about", "login", "join", "new", "organizations"];
  if (reserved.includes(owner.toLowerCase())) return null;
  return `${owner}/${repo}`;
}