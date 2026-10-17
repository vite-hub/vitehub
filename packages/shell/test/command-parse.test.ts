import { describe, expect, it } from "vitest"

import { parseShellCommand } from "../src/command/parse.ts"

describe("shell command parsing", () => {
  it("keeps backslashes literal inside single quotes", () => {
    expect(parseShellCommand("printf '%s\\n' 'hello'"))
      .toEqual(["printf", "%s\\n", "hello"])
  })

  it("retains empty quoted arguments", () => {
    expect(parseShellCommand("cmd '' \"\" end"))
      .toEqual(["cmd", "", "", "end"])
  })

  it("escapes only shell escape characters inside double quotes", () => {
    expect(parseShellCommand(String.raw`cmd "%s\n" "a\qb" "\$\`\"\\"`))
      .toEqual(["cmd", "%s\\n", "a\\qb", "$`\"\\"])
  })

  it("joins adjacent quoted and unquoted fragments", () => {
    expect(parseShellCommand("cmd pre''\"middle\"'end'"))
      .toEqual(["cmd", "premiddleend"])
  })

  it("removes escaped newlines outside single quotes", () => {
    expect(parseShellCommand("cmd \\\nword \"a\\\nb\" 'a\\\nb'"))
      .toEqual(["cmd", "word", "ab", "a\\\nb"])
  })
})
