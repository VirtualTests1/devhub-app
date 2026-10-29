/** Types for the dependency-free ESM release manifest helper. */
export const MANIFEST_NAME: string;
export const CHECKSUMS_NAME: string;
export type ReleaseFile = { path: string; size: number; sha256: string };
export type ReleaseManifest = {
  format: "devhub-release-manifest";
  version: 1;
  appVersion: string;
  files: ReleaseFile[];
};
export function listFiles(dir: string): { rel: string; abs: string }[];
export function buildManifest(dir: string, appVersion?: string): ReleaseManifest;
export function checksumsText(manifest: ReleaseManifest): string;
export function writeManifest(dir: string, outDir?: string, appVersion?: string): ReleaseManifest;
export function checkManifest(dir: string): string[];