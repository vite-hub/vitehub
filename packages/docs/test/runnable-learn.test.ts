import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { readLearnFacts, tutorialMinutes } from "../src/runnable/learn.ts"

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>()
  return { ...path, relative: vi.fn(path.relative) }
})

describe("learn facts", () => {
  it("estimates time from the prose and the steps, without code blocks", () => {
    const prose = (words: number) => Array.from({ length: words }, () => "word").join(" ")
    expect(tutorialMinutes(prose(10))).toBe(5)
    // 1000 words is 5 minutes of reading, and 3 steps add 6 minutes: 11, rounded up to 15.
    const lesson = `---\ntitle: T\n---\n${prose(1000)}\n::tutorial-step{title="a"}\n::\n::tutorial-step{title="b"}\n::\n::tutorial-step{title="c"}\n::\n`
    expect(tutorialMinutes(lesson)).toBe(15)
    expect(tutorialMinutes(`${lesson}\n\`\`\`ts\n${prose(5000)}\n\`\`\`\n`)).toBe(15)
  })

  it.each([
    { lineEnding: "LF", newline: "\n", relativePath: "docs/kv/index.md" },
    { lineEnding: "CRLF", newline: "\r\n", relativePath: "docs/kv/index.md" },
    { lineEnding: "LF", newline: "\n", relativePath: "docs\\kv\\index.md" },
    { lineEnding: "CRLF", newline: "\r\n", relativePath: "docs\\kv\\index.md" },
  ])("reads $lineEnding facts at $relativePath using a URL key", async ({ newline, relativePath }) => {
    const contentDir = await mkdtemp(join(tmpdir(), "learn-facts-"))
    try {
      const directory = join(contentDir, "docs", "kv")
      await mkdir(directory, { recursive: true })
      const markdown = [
        "---", "layout: tutorial", "---",
        "word ".repeat(600),
        "::tutorial-step{title=\"One\"}", "::",
        "::tutorial-step{title=\"Two\"}", "::",
        "```ts", "code ".repeat(5000), "```", "",
      ].join(newline)
      await writeFile(join(directory, "index.md"), markdown)
      // Windows paths use backslashes, and the key is a URL either way.
      vi.mocked(relative).mockReturnValueOnce(relativePath)

      expect(await readLearnFacts(contentDir)).toEqual({ "/docs/kv": { steps: 2, minutes: 10 } })
    }
    finally {
      vi.mocked(relative).mockReset()
      await rm(contentDir, { recursive: true, force: true })
    }
  })

  it("leaves out pages without layout: tutorial", async () => {
    const contentDir = await mkdtemp(join(tmpdir(), "learn-facts-"))
    try {
      await writeFile(join(contentDir, "guide.md"), "---\ntitle: Guide\n---\n::tutorial-step{title=\"One\"}\n::\n")
      expect(await readLearnFacts(contentDir)).toEqual({})
    }
    finally {
      await rm(contentDir, { recursive: true, force: true })
    }
  })
})
