/**
 * The repository's web page, derived from its slug.
 *
 * `RepoRef` carries host/owner/repo and no URL field, and the slug is already
 * `host/owner/repo` — so the link needs no new backend data, and adding one
 * would be a second source of truth for the same string.
 */
export function repoUrlOf(slug: string): string {
  const parts = slug.split("/");
  if (parts.length < 3) return `https://${slug}`;
  const [host, ...rest] = parts;
  return `https://${host}/${rest.join("/")}`;
}
