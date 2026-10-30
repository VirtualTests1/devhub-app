# Third-party notices

## Microsoft Edge WebView2 Bootstrapper

- File: `portable/MicrosoftEdgeWebview2Setup.exe`
- Source: <https://go.microsoft.com/fwlink/p/?LinkId=2124703>
- Version: 1.3.275.13 (`FileVersion` / `ProductVersion`)
- Purpose: install the WebView2 Runtime when it is missing; the portable launcher only runs it after asking.
- SHA-256: `aa38a8cfce6179b87181609b1c730a29eaf26138fc833af5759e67576770f3a3`
- Signature: valid Microsoft Corporation signature (`CN=Microsoft Corporation`), checked 2026-10-30. `scripts/pack-portable.ps1` re-checks it before packaging.
- License: Microsoft proprietary redistributable; distribution is governed by the Microsoft Edge WebView2 Runtime terms (<https://learn.microsoft.com/microsoft-edge/webview2/>).

## CycloneDX JSON schemas

- Files: `vendor/cyclonedx/bom-1.6.schema.json`, `vendor/cyclonedx/spdx.schema.json`
- Source: the files' `$id` values (`http://cyclonedx.org/schema/bom-1.6.schema.json`, `http://cyclonedx.org/schema/spdx.schema.json`)
- License: Apache-2.0 (stated in the BOM schema's `$comment`); the SPDX list version is `v1.1-3.29.0`.
- Purpose: offline validation for `scripts/sbom.mjs`.

No other third-party binaries are tracked in this repository. Dependency licenses are reported by `pnpm license:report` and the SBOM.
