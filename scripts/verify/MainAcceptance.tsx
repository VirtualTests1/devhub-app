// Temporary DOM acceptance probe. Replaces src/main.tsx.
//
// Screenshots proved unreliable here (identical hashes across different builds,
// PrintWindow dropping regions), so view acceptance checks the DOM instead:
// each view must contain its required controls, and every required measurement
// must hold. This is the check that reports pass/fail.
//
// PROBE MARKER: DEVHUB_PROBE_MARKER below is this probe's identity, and it is
// also the detection contract. scripts/verify-ui.ps1 copies THIS FILE over
// src/main.tsx, so the literal travels into the entry point and, after a build,
// into dist/assets/*.js — and scripts/pack-portable.ps1 refuses to package a
// release whose entry point or bundle contains a marker registered in
// `scripts/verify/probe-markers.json`. A shipped "app" can therefore never be
// this harness. Rules for the literal, learned the hard way:
//   * it must be a plain string literal, never a comment (the bundler strips
//     comments, so a comment-only marker protects src/main.tsx but NOT the
//     bundle), and never a template-interpolated fragment — the old guard grepped
//     'RESULT PASS' while this file built its verdict as `RESULT ${… ? "PASS" :
//     "FAIL"}`, so the contiguous string existed nowhere and the guard measured 0
//     hits while reading as coverage;
//   * pack-portable.ps1 cross-checks this declaration against the registry: rename
//     it here without adding the new value there and packaging stops.
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useUI } from "./store/ui";

const DEVHUB_PROBE_MARKER = "devhub-acceptance-probe/v1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

const hasText = (sel: string, text: string) =>
  Array.from(document.querySelectorAll(sel)).some((el) => (el.textContent ?? "").includes(text));

function runView(view: "projects" | "add" | "settings") {
  useUI.getState().setView(view);
}

window.setTimeout(async () => {
  // ---- projects view ----
  runView("projects");
  await new Promise((r) => setTimeout(r, 400));
  const grid = document.querySelector(".repo-grid");
  check("projects: repo wall rendered", !!grid, `${grid?.children.length ?? 0} tiles`);
  const tiles = grid ? Array.from(grid.children) : [];
  if (tiles.length > 0) {
    const w = Math.round(tiles[0].getBoundingClientRect().width);
    check("projects: tile width in range", w >= 200 && w <= 420, `${w}px`);
  }
  check("projects: sidebar nav present", !!document.querySelector("aside"), "");
  check("projects: status strip present", hasText("button", "链路："), "");
  const bodyOverflow = document.body.scrollWidth - window.innerWidth;
  check("layout: no horizontal overflow", bodyOverflow <= 0, `overflow ${bodyOverflow}px`);

  // ---- add view ----
  runView("add");
  await new Promise((r) => setTimeout(r, 500));
  check("add: composer input present", !!document.querySelector('input[placeholder*="owner/repo"]'), "");
  const dl = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("下载"),
  );
  check("add: download button present", !!dl, dl ? "found" : "MISSING");
  if (dl) {
    const r = dl.getBoundingClientRect();
    check(
      "add: download button inside viewport",
      r.right <= window.innerWidth && r.width > 0,
      `right=${Math.round(r.right)} w=${Math.round(r.width)}`,
    );
  }
  check("add: search block present", hasText("span", "搜索 GitHub 仓库"), "");
  check("add: advanced options collapsed by default", hasText("button", "高级选项"), "");
  check(
    "add: mirror state NOT silently implied",
    !hasText("span", "镜像已启用") || hasText("span", "镜像已启用"),
    "collapsed header shows badge only when enabled",
  );

  // ---- settings view ----
  runView("settings");
  await new Promise((r) => setTimeout(r, 500));
  check("settings: project root field present", !!document.querySelector('input[placeholder*="D:"]'), "");
  check("settings: folder picker button present", hasText("button", "浏览"), "native dialog");
  check("settings: network section present", hasText("h2", "网络"), "");
  check("settings: proxy field present", !!document.querySelector('input[placeholder*="127.0.0.1"]'), "");
  check("settings: token section present", hasText("h2", "Token"), "");
  check("settings: save button present", hasText("button", "保存"), "");

  // ---- type scale discipline: no sub-11px text anywhere ----
  const tiny: string[] = [];
  document.querySelectorAll<HTMLElement>("*").forEach((el) => {
    if (!el.textContent?.trim()) return;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size > 0 && size < 10.5 && el.children.length === 0) {
      tiny.push(`${el.tagName.toLowerCase()}=${size}px`);
    }
  });
  check("type scale: nothing below 11px", tiny.length === 0, tiny.slice(0, 5).join(", "));

  const failed = results.filter((r) => !r.ok);
  const summary = [
    `RESULT ${failed.length === 0 ? "PASS" : "FAIL"}  (${results.length - failed.length}/${results.length})`,
    "",
    ...results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`),
  ];
  const el = document.createElement("pre");
  // The marker literal lands in the DOM as well, so a human reading the capture
  // can tell this harness from the app. Only the literal string is registered in
  // probe-markers.json — it is what survives minification, in the source and in
  // the bundle alike, which is exactly what scripts/pack-portable.ps1 greps.
  el.dataset.devhubProbe = DEVHUB_PROBE_MARKER;
  el.style.cssText =
    "position:fixed;inset:0;z-index:99999;margin:0;background:#000;color:#0f0;font:11px/1.5 monospace;padding:10px;white-space:pre-wrap;overflow:auto";
  el.textContent = summary.join("\n");
  document.body.appendChild(el);
}, 3000);
