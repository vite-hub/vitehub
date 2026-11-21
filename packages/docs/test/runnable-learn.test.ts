import { describe, expect, it } from "vitest"

import { tutorialMinutes, tutorialPageFacts } from "../src/runnable/learn.ts"

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
    { lineEnding: "LF", newline: "\n" },
    { lineEnding: "CRLF", newline: "\r\n" },
  ])("reads the same facts from $lineEnding Markdown", ({ newline }) => {
    const markdown = [
      "---", "layout: tutorial", "---",
      "word ".repeat(600),
      "::tutorial-step{title=\"One\"}", "::",
      "::tutorial-step{title=\"Two\"}", "::",
      "```ts", "code ".repeat(5000), "```", "",
    ].join(newline)
    expect(tutorialPageFacts(markdown)).toEqual({ steps: 2, minutes: 10 })
  })
})
