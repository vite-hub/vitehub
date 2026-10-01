import { describe, expect, it } from "vitest";

import {
  allowedMissingIcons,
  assertBuildWarningBudget,
  buildWarningBudget,
} from "../scripts/build.mjs";

const zodRegexComment = "/** Anchors a pattern source. The interpolation lives here rather than at the call site because\n * esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it\n * will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */";
const annotationConclusion = "contains an annotation that Rollup cannot interpret due to the position of the comment. The comment will be removed to avoid issues.";

function annotationWarning(source: string, comment: string, detailSource = source) {
  return [
    `[warn] ${source} (2457:0): A comment`,
    "",
    `"${comment}"`,
    "",
    `in "${detailSource}" ${annotationConclusion}`,
  ].join("\n");
}

describe("docs build warning budget", () => {
  it("accepts every explicitly budgeted warning and known missing icon", () => {
    const warnings = [
      ...buildWarningBudget.flatMap((entry) =>
        Array.from({ length: entry.maximum }, () =>
          entry.comment
            ? annotationWarning(entry.source, entry.comment)
            : `[warn] ${entry.text}`,
        ),
      ),
      ...allowedMissingIcons.map((icon) => `WARN [Icon] failed to load icon ${icon}`),
    ].join("\n");

    expect(() => assertBuildWarningBudget(warnings)).not.toThrow();
  });

  it("accepts timeouts for explicitly allowed icons", () => {
    expect(() =>
      assertBuildWarningBudget(
        [
          "[warn] [Icon] loading icon `vscode-icons:file-type-css` timed out after 1500ms",
          "[warn] [Icon] failed to load icon `vscode-icons:file-type-vue` (repeated 12 times)",
          "[warn] [Icon] loading icon `vscode-icons:file-type-css` timed out after 1500ms (repeated 5 times)",
        ].join("\n"),
      ),
    ).not.toThrow();
  });

  it("accepts the two external Google Fonts metadata fetch warnings", () => {
    const iconMetadataWarning =
      "[warn] Could not fetch from `https://fonts.google.com/metadata/icons?key=material_symbols&incomplete=true`. Will retry in `1000ms`. `3` retries left.";
    const fontMetadataWarning =
      "[warn] Could not fetch from `https://fonts.google.com/metadata/fonts`. Will retry in `1000ms`. `3` retries left.";
    expect(() =>
      assertBuildWarningBudget([iconMetadataWarning, fontMetadataWarning].join("\n")),
    ).not.toThrow();

    expect(() =>
      assertBuildWarningBudget([iconMetadataWarning, iconMetadataWarning].join("\n")),
    ).toThrow("warning budget exceeded for Google Fonts icon metadata fetch: 2/1");
  });

  it("rejects other Google Fonts metadata endpoints", () => {
    for (const warning of [
      "[warn] Could not fetch from `https://fonts.google.com/metadata/fonts/Roboto`. Will retry in `1000ms`. `3` retries left.",
      "[warn] Could not fetch from `https://fonts.google.com/metadata/fonts?unexpected=true`. Will retry in `1000ms`. `3` retries left.",
    ]) {
      expect(() => assertBuildWarningBudget(warning)).toThrow("unbudgeted warning");
    }
  });

  it("rejects non-timeout loading warnings for allowed icons", () => {
    expect(() =>
      assertBuildWarningBudget(
        "[warn] [Icon] loading icon `vscode-icons:file-type-css` returned malformed data",
      ),
    ).toThrow("unbudgeted warning");
  });

  it("rejects an exceeded warning budget and an unbudgeted warning", () => {
    const timing = buildWarningBudget.find((entry) => entry.name === "build plugin timings");
    if (!timing) throw new Error("missing plugin timing budget");
    const warnings = [
      ...Array.from({ length: timing.maximum + 1 }, () => `[warn] ${timing.text}`),
      "WARN an unexpected docs build warning",
    ].join("\n");

    expect(() => assertBuildWarningBudget(warnings)).toThrow(
      /warning budget exceeded.*unbudgeted warning/s,
    );
  });

  it("rejects a new missing icon", () => {
    expect(() =>
      assertBuildWarningBudget("WARN [Icon] failed to load icon custom:new-release-icon"),
    ).toThrow("new missing icon: custom:new-release-icon");
  });

  it("accepts the normalized warning and quoted icon formats emitted by the docs build", () => {
    const warnings = [
      "[warn] [docus] AI assistant disabled: missing AI binding",
      "[warn] Could not fetch from `https://api.fontshare.com/v2/fonts`. Will retry in `1000ms`. `3` retries left.",
      "[warn] Could not fetch from `https://fonts.bunny.net/list`. Will retry in `1000ms`. `3` retries left.",
      "[warn] [PLUGIN_TIMINGS] render pages took 1s",
      "[warn] [INEFFECTIVE_DYNAMIC_IMPORT] ../node_modules/.pnpm/@nuxt+ui@4.11.0/node_modules/@nuxt/ui/dist/runtime/components/Button.vue is dynamically imported",
      "[warn] [Icon] failed to load icon `simple-icons:pnpm`",
      "[warn] [Icon] loading icon `vscode-icons:file-type-css` timed out after 1500ms",
      "[warn] [nitro] [cloudflare] Wrangler config `assets`set by config or modules is overridden and will be ignored.",
    ].join("\n");

    expect(() => assertBuildWarningBudget(warnings)).not.toThrow();
  });

  it("rejects incomplete wrapped Rollup annotation warnings", () => {
    expect(() =>
      assertBuildWarningBudget(
        [
          'WARN node_modules/.cache/nuxt/.nuxt/dist/server/_nuxt/dist.js (2457:0): A comment',
          '"contains an annotation that Rollup cannot interpret"',
        ].join("\n"),
      ),
    ).toThrow("unbudgeted warning");
  });

  it("rejects non-timeout loading failures for known icons", () => {
    expect(() =>
      assertBuildWarningBudget(
        "[warn] [Icon] loading icon `vscode-icons:file-type-css` failed because the provider returned corrupt data",
      ),
    ).toThrow(/unbudgeted warning/);
  });

  it("ignores warning words in filenames and wrapped warning details", () => {
    const output = [
      "- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.",
      "node_modules/.cache/nuxt/Warning-f4QGoboQ.js 1.74 kB",
      "├─ .output/server/chunks/build/Warning-f4QGoboQ.mjs (1.06 kB)",
    ].join("\n");

    expect(() => assertBuildWarningBudget(output)).not.toThrow();
  });

  it("does not budget an annotation from an unknown dependency source", () => {
    expect(() => assertBuildWarningBudget(
      "[warn] unknown-package.js contains an annotation that Rollup cannot interpret",
    )).toThrow("unbudgeted warning");
  });

  it("counts the complete CI Rollup warning once across a changing Nuxt chunk hash", () => {
    const warning = annotationWarning("node_modules/.cache/nuxt/.nuxt/dist/server/_nuxt/dist-Dg8NDwTS.js", zodRegexComment);
    const changedHash = annotationWarning("node_modules/.cache/nuxt/.nuxt/dist/server/_nuxt/dist-newHash.js", zodRegexComment);
    expect(() => assertBuildWarningBudget(`${warning}\n${changedHash}`)).not.toThrow();
    expect(() => assertBuildWarningBudget(`${warning}\n${changedHash}\n${warning}`)).toThrow("warning budget exceeded for Nuxt generated pure annotations: 3/2");
  });

  it.each([" WARN  ", "warning "])("accepts paired annotations with the plain %s logger prefix", prefix => {
    const output = annotationWarning("node_modules/.cache/nuxt/.nuxt/dist/server/_nuxt/dist-CJ1DFSvj.js", zodRegexComment).replace("[warn] ", prefix);
    expect(() => assertBuildWarningBudget(output)).not.toThrow();
  });

  it("rejects unmatched, mismatched, and unrelated annotation headers", () => {
    const source = "node_modules/.cache/nuxt/.nuxt/dist/server/_nuxt/dist-Dg8NDwTS.js";
    for (const output of [
      `[warn] ${source} (2457:0): A comment`,
      annotationWarning(source, zodRegexComment, "unknown-package.js"),
      annotationWarning(source, "/** unrelated annotation */"),
      annotationWarning("zod@4.5.5/node_modules/zod/v4/core/regexes.js", zodRegexComment),
      annotationWarning(source, zodRegexComment).replace('"/** Anchors', '[warn] unrelated warning\n"/** Anchors'),
    ]) expect(() => assertBuildWarningBudget(output)).toThrow("unbudgeted warning");
  });

  it("does not ignore a wrapped annotation header from an unknown source", () => {
    const output = [
      "[warn] unknown-package.js (1:0): A comment",
      "\"/** unknown annotation */\"",
      'in "unknown-package.js" contains an annotation that Rollup cannot interpret',
    ].join("\n");
    expect(() => assertBuildWarningBudget(output)).toThrow("unbudgeted warning");
  });

  it("rejects lowercase logger warnings and standard Node warnings", () => {
    const warnings = [
      "[warn] an unexpected docs build warning",
      "(node:123) Warning: unexpected docs integration",
      "(node:123) [DEP0040] DeprecationWarning: deprecated docs API",
      "(node:123) DeprecationWarning: deprecated docs integration",
      "ExperimentalWarning: experimental docs integration",
    ].join("\n");

    expect(() => assertBuildWarningBudget(warnings)).toThrow(
      /unbudgeted warning.*Warning: unexpected.*\[DEP0040].*DeprecationWarning.*ExperimentalWarning/s,
    );
  });
});
