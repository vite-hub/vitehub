import { describe, expect, it, vi } from "vitest"

import { parseShellCommand } from "../src/command/parse.ts"
import { createCloudflareShellProvider } from "../src/providers/cloudflare.ts"

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

  it("preserves quoted arguments at the Cloudflare client boundary", async () => {
    const exec = vi.fn(async () => ({ code: 0, stderr: "", stdout: "" }))
    const provider = createCloudflareShellProvider({ sandbox: {
      exec,
      supports: { execCwd: true, execEnv: true },
    } })
    await provider.exec("printf '%s\\n' '' \"hello world\"")
    expect(exec).toHaveBeenCalledWith("printf", ["%s\\n", "", "hello world"], expect.any(Object))
  })
})

it("does not forward unsupported cwd or env options to Cloudflare clients", async () => {
  const calls: unknown[] = []
  const exec = vi.fn(async (_command: string, _args?: string[], options?: Record<string, unknown>) => {
    calls.push(options)
    if (options && ("cwd" in options || "env" in options)) {
      throw new Error("client received unsupported execution options")
    }
    return { code: 0, stderr: "", stdout: "" }
  })
  const provider = createCloudflareShellProvider({
    sandbox: { exec, supports: { execCwd: false, execEnv: false } },
  })

  await expect(provider.exec("printf ok", {
    cwd: "/workspace",
    env: { SECRET: "value" },
  })).resolves.toMatchObject({ exitCode: 0 })
  expect(calls).toHaveLength(1)
  expect(calls[0]).not.toHaveProperty("cwd")
  expect(calls[0]).not.toHaveProperty("env")
})
