// Extension-less imports in the test tree are resolved to `.ts` here because
// Node's ESM resolver (unlike Vite and `moduleResolution: bundler`) does not
// try extensions on its own.
//
// Round 13 (d8-2): the loop used to try `.tsx` after `.ts`. That branch could
// never succeed: Node's type stripping refuses `.tsx` outright (DEVELOPMENT.md
// §8.1), so a resolved `.tsx` would fail at load time anyway - and an
// unresolvable `.tsx` was the outcome with or without the extra attempt. The
// dead attempt also made the helper look like it supported view files, which
// is exactly the "views are not testable at this layer" boundary the docs draw.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    try {
      return await nextResolve(specifier + ".ts", context);
    } catch {
      /* fall through to the plain specifier */
    }
  }
  return nextResolve(specifier, context);
}
export function initialize() {}
