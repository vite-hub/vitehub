import { describe, expect, it } from "vitest"

import { parseShellCommand } from "../src/command/parse.ts"

describe("shell command parsing", async () => {
  it("keeps backslashes literal inside single quotes", async () => {
    await expect(parseShellCommand("printf '%s\\n' 'hello'"))
      .resolves.toEqual(["printf", "%s\\n", "hello"])
  })

  it("retains empty quoted arguments", async () => {
    await expect(parseShellCommand("cmd '' \"\" end"))
      .resolves.toEqual(["cmd", "", "", "end"])
  })

  it("escapes only shell escape characters inside double quotes", async () => {
    await expect(parseShellCommand(String.raw`cmd "%s\n" "a\qb" "\$\`\"\\"`))
      .resolves.toEqual(["cmd", "%s\\n", "a\\qb", "$`\"\\"])
  })

  it("joins adjacent quoted and unquoted fragments", async () => {
    await expect(parseShellCommand("cmd pre''\"middle\"'end'"))
      .resolves.toEqual(["cmd", "premiddleend"])
  })

  it("keeps compound statements visible as a command word", async () => {
    await expect(parseShellCommand("if true; then rm README.md; fi"))
      .resolves.toEqual(["if"])
  })

  it("does not treat a leading comment as a trailing comment", async () => {
    await expect(parseShellCommand("# note\nrm README.md"))
      .resolves.toEqual(["rm", "README.md"])
  })

  it("uses the parsed shell AST for assignments and substitutions", async () => {
    await expect(parseShellCommand("FOO=bar echo $(pwd) 'x'"))
      .resolves.toEqual(["FOO=bar", "echo", "$(pwd)", "x"])
  })

  it("removes escaped newlines outside single quotes", async () => {
    await expect(parseShellCommand("cmd \\\nword \"a\\\nb\" 'a\\\nb'"))
      .resolves.toEqual(["cmd", "word", "ab", "a\\\nb"])
  })
})
