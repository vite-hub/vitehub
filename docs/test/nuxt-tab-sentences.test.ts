import { readFile, readdir } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const contentRoot = resolve(import.meta.dirname, "../content/docs")

/** Sentences that an open pull request already removes, with that pull request. */
const pending: Record<string, string> = {
  "queue/get-started.md Did you choose Nuxt in Installation?": "#3896 removes this sentence.",
}

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await markdownFiles(path))
    else if (entry.name.endsWith(".md")) files.push(path)
  }
  return files
}

/** The prose paragraphs of a page, without code blocks and block markers, with the line where each one starts. */
function paragraphs(source: string): { line: number, text: string }[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n")
  const out: { line: number, text: string }[] = []
  let current: { line: number, text: string } | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fence = /^\s*(`{3,})/.exec(line)
    if (fence) {
      while (++index < lines.length && lines[index]!.trim() !== fence[1]);
      current = undefined
      continue
    }
    if (!line.trim() || /^\s*:{2,}/.test(line) || /^\s*#/.test(line)) {
      current = undefined
      continue
    }
    // A list item starts a new paragraph.
    const item = /^\s*(?:>\s*)?(?:[-*]|\d+\.)\s+/.exec(line)
    const text = line.slice(item?.[0].length ?? 0).replace(/^\s*>\s*/, "").trim()
    if (!current || item) {
      current = { line: index + 1, text }
      out.push(current)
    }
    else current.text += ` ${text}`
  }
  return out
}

/**
 * A sentence that tells Nuxt readers where to put the config. On a page with a Nuxt framework tab, the tab is the
 * Nuxt path, so such a sentence repeats the tab or contradicts it.
 */
function nuxtLeftover(sentence: string): boolean {
  if (/^Did you choose Nuxt\b/.test(sentence)) return true
  const lead = /^(?:If you use Nuxt\b|(?:In|For|With) Nuxt,|Select the Nuxt tab\b)/.test(sentence)
  return lead && /`vite-hub\/nuxt`|nuxt\.config|`vitehub` key|ViteHub module|module (?:config|options)/.test(sentence)
}

describe("Nuxt framework tabs", async () => {
  const pages = await Promise.all((await markdownFiles(contentRoot)).map(async path => ({
    page: relative(contentRoot, path),
    source: await readFile(path, "utf8"),
  })))

  it("has no sentence that repeats the Nuxt tab", () => {
    const leftovers = pages
      .filter(({ source }) => /sync="framework"/.test(source) && /(?:label|name)="Nuxt"/.test(source))
      .flatMap(({ page, source }) => paragraphs(source).flatMap(({ line, text }) => text
        .split(/(?<=[.?!])\s+/)
        .filter(sentence => nuxtLeftover(sentence) && !pending[`${page} ${sentence}`])
        .map(sentence => `${page}:${line} ${sentence}`)))
    expect(leftovers).toEqual([])
  })
})
