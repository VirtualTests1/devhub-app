/**
 * Packaged-build runtime check (r34-D10).
 *
 * The r33 CSP/opener verification used a dev URL served by Vite. A packaged build
 * uses Tauri's own protocol and is where a `connect-src 'self'` mistake would
 * actually bite; this scenario runs against `tauri build --debug --no-bundle`
 * and asserts the origin, the IPC path and the new r34 commands.
 *
 * Usage (after `pnpm build` and `pnpm tauri build --debug --no-bundle`):
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
 *   $env:DEVHUB_PROJECT_ROOT="<repo>\.mcpfixtures\container"
 *   src-tauri\target\debug\devhub-app.exe
 *   node scripts/cdp.mjs scripts/scenarios/packaged-runtime.mjs --port 9223
 */
export default async function (cdp) {
  await cdp.waitFor("document.querySelector('#devhub-main') !== null", { timeoutMs: 30000 });
  const out = await cdp.evaluate(`
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    const call = async (name, args) => {
      try { return { ok: true, value: await invoke(name, args) }; }
      catch (e) { return { ok: false, error: String(e) }; }
    };
    const version = await call("app_version");
    const repos = await call("list_repositories", { force: false });
    const health = await call("repo_health_overview");
    return {
      href: location.href,
      origin: location.origin,
      packagedProtocol: !/^https?:\\/\\/localhost/.test(location.href),
      hasMain: document.querySelector('#devhub-main') !== null,
      skipLink: document.querySelector('a[href="#devhub-main"]')?.textContent ?? null,
      version: version.ok ? version.value : version.error,
      repoCount: repos.ok && Array.isArray(repos.value) ? repos.value.length : null,
      repoError: repos.ok ? null : repos.error,
      healthScanned: health.ok ? health.value.scanned : null,
      healthError: health.ok ? null : health.error,
    };
  `);
  out.consoleErrors = cdp.consoleErrors
    .filter((line) => /Content Security Policy|Refused to|violat/i.test(String(line)))
    .slice(0, 5);
  return out;
}
