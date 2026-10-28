/**
 * Baseline application state (settings seed + repository listing).
 *
 * Two things are checked here that no other scenario covers:
 *
 *   1. `ipPinEnabled` must be TRUE with no config file present. It is the
 *      documented default, the UI states it, and the downloader's IP-pinning layer
 *      depends on it - but the in-memory state used to be built with
 *      `Settings::default()`, which is `false` for both flags. So on every launch
 *      the toggle showed OFF, pinning was silently unused, and the first save wrote
 *      that wrong value down.
 *   2. Repository identity comes from each repository's `.devhub.json`, so the flat
 *      layout, the legacy layout and (in principle) a hand-copied directory are all
 *      listed with their real host and owner.
 */

export default async function (cdp) {
  return cdp.evaluate(`
    const settings = await window.__TAURI_INTERNALS__.invoke('get_settings');
    const env = await window.__TAURI_INTERNALS__.invoke('environment');
    const repos = await window.__TAURI_INTERNALS__.invoke('list_repositories');
    const strip = (v) => v;
    return {
      settings: {
        projectRoot: settings.projectRoot,
        projectRootIsDefault: settings.projectRootIsDefault,
        mirrorEnabled: settings.mirrorEnabled,
        ipPinEnabled: settings.ipPinEnabled,
        configPath: settings.configPath,
        effectiveMirrors: settings.effectiveMirrors.length,
      },
      environment: {
        projectRoot: env.projectRoot,
        git: env.git ? env.git.version + ' (' + env.git.source + ')' : null,
        localProxy: env.localProxy,
        resolvedIp: env.resolvedIp,
        ipPinEnabled: env.ipPinEnabled,
        mirrorEnabled: env.mirrorEnabled,
        elevated: env.elevated,
      },
      repos: repos.map((r) => r.host + '/' + r.owner + '/' + r.repo).sort(),
      ipPinningDefaultsOn: settings.ipPinEnabled === true && env.ipPinEnabled === true,
      mirrorsStayOptIn: settings.mirrorEnabled === false && env.mirrorEnabled === false,
      notElevated: env.elevated === false,
      bothLayoutsListed:
        repos.some((r) => r.slug === undefined && r.repo === 'opus-video-prompts' && r.owner === 'joeseesun' && r.host === 'github.com') &&
        repos.some((r) => r.repo === 'tool' && r.owner === 'alice' && r.host === 'github.com'),
      verdict:
        settings.ipPinEnabled === true && env.ipPinEnabled === true && settings.mirrorEnabled === false
          ? 'PASS'
          : 'FAIL',
    };
  `);
}
