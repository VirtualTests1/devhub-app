/**
 * r22-O4 的源码侧钉子：卡片的五个对话框与快捷键面板必须保持**动态导入**。
 *
 * 这条测试不是在数行数，而是在防一种很容易悄悄回退的改动：把 `const X = lazy(...)`
 * 换回 `import { X } from ...` 只需要一行，构建仍然成功，入口 chunk 却会重新吃进
 * 设置面板、Markdown 解析器与命令面板。`scripts/check-dist.mjs` 的 initial-JS 预算
 * 会在构建期发现体积回退，但那条检查要跑 build；这条在 `pnpm test` 里就能指出是哪个
 * 文件、哪个组件被静态导入了。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PROJECTS = "src/views/ProjectsView.tsx";
const SHELL = "src/shell/AppShell.tsx";

const CARD_DIALOGS = [
  ["ProjectSettingsDialog", "dialogs/ProjectSettingsDialog"],
  ["RepoReadmeDialog", "dialogs/RepoReadmeDialog"],
  ["RepoDiagnoseDialog", "dialogs/RepoDiagnoseDialog"],
  ["RepoGrepDialog", "dialogs/RepoGrepDialog"],
  ["RepoFilesDialog", "dialogs/RepoFilesDialog"],
  ["RepoTagsDialog", "components/RepoTagsDialog"],
] as const;

const SHELL_SURFACES = [
  ["CommandPalette", "components/CommandPalette"],
  ["ShortcutHelpDialog", "components/ShortcutHelpDialog"],
] as const;

test("lazy dialogs: 卡片对话框没有静态 import，且都以 lazy(() => import(...)) 注册", () => {
  const src = readFileSync(PROJECTS, "utf8");
  for (const [name, path] of CARD_DIALOGS) {
    assert.doesNotMatch(
      src,
      new RegExp(`import\\s*\\{\\s*${name}\\s*\\}\\s*from\\s*"[^"]*${path.replace("/", "\\/")}"`),
      `${name} 又变回了静态 import —— 入口 chunk 会重新吃进它`,
    );
    assert.match(
      src,
      new RegExp(`const\\s+${name}\\s*=\\s*lazy\\(\\(\\)\\s*=>\\s*[\\s\\S]{0,200}?import\\("[^"]*${path.replace("/", "\\/")}"\\)`),
      `${name} 必须通过 lazy(() => import("${path}")) 加载`,
    );
  }
  assert.match(src, /preloadCardDialogs/, "首帧之后的预取函数必须还在（打开时不应看到 chunk 拉取）");
  assert.match(src, /<Suspense fallback=\{null\}>/, "lazy 子组件必须有 Suspense 边界");
});

test("lazy dialogs: 命令面板与快捷键帮助也不在 shell 的静态依赖里", () => {
  const src = readFileSync(SHELL, "utf8");
  for (const [name, path] of SHELL_SURFACES) {
    assert.doesNotMatch(
      src,
      new RegExp(`import\\s*\\{\\s*${name}\\s*\\}\\s*from\\s*"[^"]*${path.replace("/", "\\/")}"`),
      `${name} 又变回了静态 import —— 命令面板的 BM25 与设置目录会回到入口 chunk`,
    );
    assert.match(
      src,
      new RegExp(`const\\s+${name}\\s*=\\s*lazy\\(\\(\\)\\s*=>\\s*[\\s\\S]{0,200}?import\\("[^"]*${path.replace("/", "\\/")}"\\)`),
      `${name} 必须通过 lazy(() => import("${path}")) 加载`,
    );
  }
  assert.match(src, /setTimeout\([\s\S]{0,200}?import\("\.\.\/components\/CommandPalette"\)/, "首帧后的预取必须还在");
});

test("r23 lazy sections: 星标导入与设置四个独立面板必须保持按需导入", () => {
  const add = readFileSync("src/views/AddRepoView.tsx", "utf8");
  assert.equal(add.includes('import { StarImportPanel }'), false, "StarImportPanel 又变回静态导入");
  assert.ok(add.includes('const StarImportPanel = lazy(() =>'), "StarImportPanel 必须是 lazy");
  assert.ok(add.includes('import("../components/StarImportPanel")'), "StarImportPanel 的 import 路径变了");
  assert.ok(add.includes("<Suspense fallback={null}>"), "lazy 面板必须有 Suspense 边界");

  const settings = readFileSync("src/views/SettingsView.tsx", "utf8");
  for (const name of ["FailureHistorySection", "DockerDiagnosticsSection", "DepsUpdateSection", "DeepLinkSection"]) {
    assert.equal(settings.includes(`import { ${name} }`), false, `${name} 又变回静态导入`);
    assert.ok(settings.includes(`const ${name} = lazy(() =>`), `${name} 必须是 lazy`);
    assert.ok(settings.includes(`import("./settings/${name}")`), `${name} 的 import 路径变了`);
  }
});
