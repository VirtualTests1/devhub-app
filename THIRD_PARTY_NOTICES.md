# Third-party notices

## Microsoft Edge WebView2 Bootstrapper

- File: `portable/MicrosoftEdgeWebview2Setup.exe`
- Source: <https://go.microsoft.com/fwlink/p/?LinkId=2124703>
- Purpose: install the WebView2 Runtime when it is missing; the portable launcher only runs it after asking.
- SHA-256: `aa38a8cfce6179b87181609b1c730a29eaf26138fc833af5759e67576770f3a3`
- Signature: valid Microsoft Corporation signature (checked 2026-10-28). `scripts/pack-portable.ps1` re-checks it before packaging.

No other third-party binaries are tracked in this repository. Dependency licenses are reported by `pnpm license:report` and the SBOM.
