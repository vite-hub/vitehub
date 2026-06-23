import { describe, expect, it, vi } from "vitest"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

const emptyWorkspace = () => ({
  fs: {
    exists: vi.fn(async () => false),
    glob: vi.fn(async () => []),
    list: vi.fn(async () => []),
    materializeSources: vi.fn(async () => ({ bytes: 0, directories: 0, durationMs: 0, files: 0, path: "", sources: [] })),
    readFile: vi.fn(async () => { throw new Error("missing") }),
    search: vi.fn(async () => []),
    stat: vi.fn(async () => { throw new Error("missing") }),
  },
  tools: {
    inspect: vi.fn(() => ({})),
    none: vi.fn(() => ({})),
  },
})

describe("pullRequestContext", () => {
  it("requires an explicit workspace when contributing sources", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { pullRequestContext } = await import("../src/capabilities.ts")

    expect(() => defineAgent({
      capabilities: [
        pullRequestContext({
          sources: {
            pullRequest: {
              async getKeys() {
                return []
              },
              async getItem(key: string) {
                return { content: "", key }
              },
            },
          },
        }),
      ],
      run: () => "ok",
    })).toThrow("pull-request-context() requires an explicit workspace")
  })

  it("records pull request metadata and contributes workspace inputs", async () => {
    const { pullRequestContext } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const context = createAgentInvocationContextStore()

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        pullRequestContext({
          context: {
            headRef: "feature",
            number: 42,
            repository: "acme/app",
          },
          rules: {
            "artifacts/review/**": { write: true },
          },
          sources: {
            pullRequest: {
              materialize: "lazy",
              mount: "pull-request",
              async getKeys() {
                return ["body.md"]
              },
              async getItem(key: string) {
                return {
                  content: "PR body",
                  key,
                  mediaType: "text/markdown",
                }
              },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      context,
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(context.get("pullRequest")).toEqual({
      headRef: "feature",
      number: 42,
      repository: "acme/app",
    })
    await expect(resolved.workspace?.fs.readFile("pull-request/body.md")).resolves.toBe("PR body")
    expect(resolved.registries.workspaceContributions).toEqual([
      {
        capabilityId: "pull-request-context",
        rules: ["artifacts/review/**"],
        sources: ["pullRequest"],
      },
    ])
  })
})
