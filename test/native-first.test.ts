import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { repoRoot } from "./utils/repo"

/** The parts of the native-first rule in AGENTS.md that code can check. */

// Tracked files only, so build output, caches, and test fixtures stay out.
const tracked = execFileSync("git", ["ls-files", "--", "package.json", "packages", "docs", "playground"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter(file => file && !/(?:^|\/)(?:test|fixtures)\//.test(file))

const manifests = tracked.filter(file => /(?:^|\/)package\.json$/.test(file))
const sources = tracked.filter(file => /\.(?:vue|ts|mts|js|mjs)$/.test(file) && !/\.test\.ts$/.test(file))
  .map(file => ({ file, text: readFileSync(join(repoRoot, file), "utf8") }))

const dateLibraries = ["dayjs", "moment", "date-fns", "luxon", "@js-joda/core"]

describe("native first", () => {
  it("adds no date library", () => {
    const found = manifests.flatMap((file) => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, file), "utf8")) as Record<string, unknown>
      const names = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
        .flatMap(field => Object.keys((manifest[field] ?? {}) as Record<string, string>))
      return names.filter(name => dateLibraries.includes(name)).map(name => `${file}: ${name}`)
    })
    expect(found, `Use Intl and Date. See "Native first" in AGENTS.md.\n${found.join("\n")}`).toEqual([])
  })

  it("loads no polyfill from a CDN", () => {
    const found = sources.filter(({ text }) => /polyfill\.io|polyfill-fastly|cdnjs\.cloudflare\.com\/polyfill|\/\/[^"'`\s]*\/polyfill(?:\.min)?\.js/.test(text)).map(({ file }) => file)
    expect(found, `Load a polyfill from the bundle with a dynamic import. See "Native first" in AGENTS.md.\n${found.join("\n")}`).toEqual([])
  })

  it("copies with execCommand only in the CopyButton fallback", () => {
    const found = sources
      .filter(({ file, text }) => file !== "packages/ui/src/components/copy-button.ts" && /execCommand\(\s*["'`]copy/.test(text))
      .map(({ file }) => file)
    expect(found, `Use CopyButton or navigator.clipboard. See "Native first" in AGENTS.md.\n${found.join("\n")}`).toEqual([])
  })
})
