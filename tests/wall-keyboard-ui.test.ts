/**
 * `RepoTile.tsx` + `ProjectsView.tsx` — the wall's arrow-key wiring.
 *
 * The geometry is covered by `tests/wall-keyboard.test.ts`; here we pin that the
 * handler is attached to the grid, finds cards by the stable attribute, skips
 * modifier chords and active drags, and moves focus (not just scroll).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tFor } from "../src/lib/i18n.ts";

const TILE = readFileSync("src/components/RepoTile.tsx", "utf8");
const VIEW = readFileSync("src/views/ProjectsView.tsx", "utf8");

test("磁贴: 卡片根节点带 data-wall-card 与 slug，供几何与定位使用", () => {
  assert.match(TILE, /data-wall-card/);
  assert.match(TILE, /data-slug=\{slug\}/);
});

test("项目页: 方向键来自纯模块，网格监听，拖动与修饰键不抢", () => {
  assert.match(VIEW, /import \{ isWallNavKey, nextCardIndex \} from "\.\.\/lib\/wall-keyboard"/);
  assert.match(VIEW, /const onWallKeyDown = \(e: React\.KeyboardEvent<HTMLDivElement>\) => \{/);
  assert.match(VIEW, /if \(dragging \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey \|\| e\.shiftKey\) return;/);
  assert.match(VIEW, /onKeyDown=\{onWallKeyDown\}/);
  assert.match(VIEW, /cards\.map\(\(c\) => c\.getBoundingClientRect\(\)\)/);
  assert.match(VIEW, /cards\[next\]\?\.focus\(\)/, "焦点必须真的移动，否则 Enter 仍作用在旧卡片");
  assert.match(VIEW, /e\.preventDefault\(\)/, "只有真的移动时才拦截滚动");
});

test("项目页: 方向键处理不越过卡片边界（点在网格空白处不动作）", () => {
  assert.match(VIEW, /target\?\.closest<HTMLElement>\("\[data-wall-card\]"\)/);
  assert.match(VIEW, /if \(!card \|\| !e\.currentTarget\.contains\(card\)\) return;/);
  assert.match(VIEW, /if \(next < 0 \|\| next === at\) return;/);
});

test("可发现性: 卡片 tooltip 说明键法，zh/en 成对", () => {
  assert.match(TILE, /lines\.push\(t\("wall\.kbdHint"\)\)/);
  assert.match(tFor("zh-CN", "wall.kbdHint"), /方向键/);
  assert.match(tFor("en", "wall.kbdHint"), /arrow keys/);
});
