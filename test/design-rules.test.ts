import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { createSourceFile, getLeadingCommentRanges, getTrailingCommentRanges, ScriptTarget } from "typescript"
import { describe, expect, it } from "vitest"
import { repoRoot, walkFiles } from "./utils/repo"
import type { Node } from "typescript"

/**
 * The rules of the ViteHub design system (docs/DESIGN.md) that code can check. The theme in @vite-hub/ui draws focus,
 * colors, and tabs once, so the surfaces that use it must not set their own.
 */
const surfaces = [
  "packages/vite-hub/src/console",
  "packages/docs/runtime",
  "packages/docs/src",
  "packages/ui/src",
  "packages/ui/styles.css",
  "docs/app",
  "playground",
]

// The theme itself, generated images, and files whose colors are data, such as brand logos.
const allowed = [
  "packages/ui/theme.css",
  "packages/ui/src/theme.ts",
  "packages/docs/runtime/app/components/OgImage/",
  "packages/vite-hub/src/console/runtime/components/invocation/internal/brand-icons.ts",
  // The pages that the server renders before the Console app loads copy the tokens of theme.css, and a test keeps them equal.
  "packages/vite-hub/src/console/standalone-page.ts",
  "docs/app/data/brand-colors.ts",
  "docs/app/examples/",
]

const ignoreDirs = new Set([".nuxt", ".output", ".vitehub", "dist", "node_modules"])
const sourceFile = /\.(vue|ts|css)$/

interface Finding {
  file: string
  line: number
  rule: string
  text: string
}

const rules: Array<{ rule: string, pattern: RegExp }> = [
  // A Tailwind class that draws focus: an outline or a ring under a focus variant.
  { rule: "focus class", pattern: /(?:^|[\s"'`[])(?:[\w-]+:)*(?:focus|focus-visible|focus-within|has-focus-visible|group-focus-visible|peer-focus-visible)(?::[\w[\]&>=-]+)*:(?:outline|ring)(?:-[\w/[\]().-]+)?(?=[\s"'`\]]|$)/ },
  // A CSS rule that draws focus.
  { rule: "focus css", pattern: /:focus(?:-visible|-within)?\b[^{]*\{[^}]*(?:outline|box-shadow)\s*:/ },
  // A color literal, also inside a Tailwind arbitrary value such as `shadow-[0_1px_rgb(0_0_0/4%)]`. Colors come from the theme tokens.
  { rule: "color literal", pattern: /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![\w-])|(?:\b|(?<=_))(?:rgb|rgba|hsl|hsla|oklch)\(\s*\d/ },
  // A tab strip built by hand. UTabs has the keyboard behavior and the theme's underline.
  { rule: "hand-made tabs", pattern: /role=["']tab(?:list)?["']|role:\s*["']tab(?:list)?["']/ },
]

function withoutComments(file: string, text: string): string {
  if (!file.endsWith(".ts")) return text
  const source = createSourceFile(file, text, ScriptTarget.Latest)
  const ranges = new Map<number, number>()
  function visit(node: Node) {
    for (const range of [...getLeadingCommentRanges(text, node.pos) ?? [], ...getTrailingCommentRanges(text, node.end) ?? []]) {
      ranges.set(range.pos, range.end)
    }
    for (const child of node.getChildren(source)) visit(child)
  }
  visit(source)
  // Keep offsets and newlines so findings still point to the original source.
  let result = text
  for (const [start, end] of ranges) {
    result = result.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/g, " ") + result.slice(end)
  }
  return result
}

function scanSource(file: string, text: string): Finding[] {
  const findings: Finding[] = []
  const source = withoutComments(file, text)
  // CSS rules can span lines, so the focus css rule reads the whole file and reports the line where the rule starts.
  for (const { rule, pattern } of rules) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`)
    for (const match of source.matchAll(global)) {
      const line = source.slice(0, match.index).split("\n").length
      findings.push({ file, line, rule, text: match[0].trim().slice(0, 80) })
    }
  }
  return findings
}

function scan(): Finding[] {
  const findings: Finding[] = []
  for (const surface of surfaces) {
    const root = join(repoRoot, surface)
    const files = surface.endsWith(".css") ? [root] : walkFiles(root, { ignoreDirs }).filter(file => sourceFile.test(file))
    for (const file of files) {
      const path = relative(repoRoot, file)
      if (allowed.some(prefix => path.startsWith(prefix)) || /\.test\.ts$/.test(path)) continue
      findings.push(...scanSource(path, readFileSync(file, "utf8")))
    }
  }
  return findings
}

describe("design rules", () => {
  const findings = scan()

  for (const { rule } of rules) {
    it(`no ${rule} outside the theme`, () => {
      const found = findings.filter(finding => finding.rule === rule).map(finding => `${finding.file}:${finding.line} ${finding.text}`)
      expect(found, `${found.length} × ${rule}. See docs/DESIGN.md.\n${found.join("\n")}`).toEqual([])
    })
  }

  it("ignores issue references in TypeScript comments", () => {
    expect(scanSource("example.ts", [
      "// `#123` links to an issue.",
      "const value = 1 // See #abc.",
      "/* A comment with #123. */",
      "function empty() { /* #abc */ }",
    ].join("\n"))).toEqual([])
  })

  it("reports color literals in TypeScript strings at their original lines", () => {
    expect(scanSource("example.ts", [
      "/* #123",
      " * #abc */",
      "const color = '#123' // #abc",
      "const url = 'https://example.com/?color=#abc'",
      "const template = `prefix ${color} #def`",
    ].join("\n"))).toEqual([
      { file: "example.ts", line: 3, rule: "color literal", text: "#123" },
      { file: "example.ts", line: 4, rule: "color literal", text: "#abc" },
      { file: "example.ts", line: 5, rule: "color literal", text: "#def" },
    ])
  })
})
