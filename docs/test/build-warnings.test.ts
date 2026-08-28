import { describe, expect, it } from "vitest"

import { allowedMissingIcons, assertBuildWarningBudget, buildWarningBudget } from "../scripts/build.mjs"

describe("docs build warning budget", () => {
  it("accepts every explicitly budgeted warning and known missing icon", () => {
    const warnings = [
      ...buildWarningBudget.flatMap(entry => Array.from({ length: entry.maximum }, () => entry.warningTokenRequired === false ? entry.text : `[warn] ${entry.text}`)),
      ...allowedMissingIcons.map(icon => `WARN [Icon] failed to load icon ${icon}`),
    ].join("\n")

    expect(() => assertBuildWarningBudget(warnings)).not.toThrow()
  })

  it("rejects an exceeded warning budget and an unbudgeted warning", () => {
    const timing = buildWarningBudget.find(entry => entry.name === "build plugin timings")
    if (!timing) throw new Error("missing plugin timing budget")
    const warnings = [
      ...Array.from({ length: timing.maximum + 1 }, () => `[warn] ${timing.text}`),
      "WARN an unexpected docs build warning",
    ].join("\n")

    expect(() => assertBuildWarningBudget(warnings)).toThrow(/warning budget exceeded.*unbudgeted warning/s)
  })

  it("rejects a new missing icon", () => {
    expect(() => assertBuildWarningBudget("WARN [Icon] failed to load icon custom:new-release-icon"))
      .toThrow("new missing icon: custom:new-release-icon")
  })

  it("accepts the normalized warning and quoted icon formats emitted by the docs build", () => {
    const warnings = [
      "[warn] [docus] AI assistant disabled: missing AI binding",
      "[warn] Could not fetch from `https://api.fontshare.com/v2/fonts`. Will retry in `1000ms`. `3` retries left.",
      "[warn] [PLUGIN_TIMINGS] render pages took 1s",
      "[warn] [INEFFECTIVE_DYNAMIC_IMPORT] Button.vue is dynamically and statically imported",
      "[warn] [Icon] failed to load icon `simple-icons:pnpm`",
      "[warn] [nitro] [cloudflare] Wrangler config `assets`set by config or modules is overridden and will be ignored.",
    ].join("\n")

    expect(() => assertBuildWarningBudget(warnings)).not.toThrow()
  })

  it("ignores warning words in filenames and wrapped warning details", () => {
    const output = [
      "- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.",
      "node_modules/.cache/nuxt/Warning-f4QGoboQ.js 1.74 kB",
      "├─ .output/server/chunks/build/Warning-f4QGoboQ.mjs (1.06 kB)",
    ].join("\n")

    expect(() => assertBuildWarningBudget(output)).not.toThrow()
  })

  it("rejects lowercase logger warnings and standard Node warnings", () => {
    const warnings = [
      "[warn] an unexpected docs build warning",
      "(node:123) Warning: unexpected docs integration",
      "(node:123) [DEP0040] DeprecationWarning: deprecated docs API",
      "(node:123) DeprecationWarning: deprecated docs integration",
      "ExperimentalWarning: experimental docs integration",
    ].join("\n")

    expect(() => assertBuildWarningBudget(warnings)).toThrow(/unbudgeted warning.*Warning: unexpected.*\[DEP0040].*DeprecationWarning.*ExperimentalWarning/s)
  })
})
