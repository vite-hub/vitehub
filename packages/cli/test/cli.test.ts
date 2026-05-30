import { describe, expect, it, vi } from "vitest"

import { runViteHubCli } from "../src/index.ts"

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

describe("ViteHub CLI", () => {
  it("routes package-contributed CLI features", async () => {
    const stdout = stream()
    const stderr = stream()
    const run = vi.fn(() => 0)

    const exitCode = await runViteHubCli({
      args: ["agent", "eval", "support"],
      cwd: "/repo",
      loadConfig: async () => ({
        plugins: [{
          vitehub: {
            cli: {
              namespaces: [{
                features: [{ name: "eval", run }],
                name: "agent",
              }],
            },
          },
        }],
        root: "/repo",
      }) as never,
      stderr,
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(run).toHaveBeenCalledWith(["support"], expect.objectContaining({ rootDir: "/repo" }))
    expect(stderr.output()).toBe("")
  })

  it("prints namespace help", async () => {
    const stdout = stream()
    const exitCode = await runViteHubCli({
      args: ["agent"],
      loadConfig: async () => ({
        plugins: [{
          vitehub: {
            cli: {
              namespaces: [{
                description: "Agent development workflows.",
                features: [{ description: "Run ViteHub Agent Evals.", name: "eval", run: () => undefined }],
                name: "agent",
              }],
            },
          },
        }],
        root: "/repo",
      }) as never,
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toContain("Usage: vite-hub agent <feature>")
    expect(stdout.output()).toContain("eval")
  })

  it("routes feature help to the package feature", async () => {
    const run = vi.fn(() => 0)
    const exitCode = await runViteHubCli({
      args: ["agent", "eval", "--help"],
      loadConfig: async () => ({
        plugins: [{
          vitehub: {
            cli: {
              namespaces: [{
                features: [{ name: "eval", run }],
                name: "agent",
              }],
            },
          },
        }],
        root: "/repo",
      }) as never,
    })

    expect(exitCode).toBe(0)
    expect(run).toHaveBeenCalledWith(["--help"], expect.objectContaining({ rootDir: "/repo" }))
  })

  it("returns one for unknown namespaces", async () => {
    const stderr = stream()
    const exitCode = await runViteHubCli({
      args: ["kv", "list"],
      loadConfig: async () => ({ plugins: [], root: "/repo" }) as never,
      stderr,
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("Unknown ViteHub CLI namespace: kv")
  })
})
