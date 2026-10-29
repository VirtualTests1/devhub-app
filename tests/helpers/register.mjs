import { register } from "node:module";
register("./ts-resolver.mjs", import.meta.url);

// The app ships the English dictionary as a lazy chunk (r32-O1). The test
// process installs the same table eagerly so every assertion and `tFor("en")`
// sees the shipped values; production still pays for it only on demand.
if (process.env.DEVHUB_TEST_SKIP_ENGLISH !== "1") {
  const [{ installEnglish }, { EN_VALUES }] = await Promise.all([
    import("../../src/lib/i18n.ts"),
    import("../../src/lib/i18n-en.ts"),
  ]);
  installEnglish(EN_VALUES);
}
