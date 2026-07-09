import { describe, expect, it, vi } from "vitest"

import { resolveAgentCapabilities } from "../src/capability-runtime.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"

import type { RepositoryHostClient } from "../src/capabilities.ts"

const runtime = (capabilities: Record<string, unknown> = {}) => ({
  capabilities,
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

describe("repositoryHostContext", () => {
  it("records a data-only async record without workspace context files", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const context = createAgentInvocationContextStore()

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          context: {
            pullRequest: {
              head: { ref: "feature" },
              number: 42,
              repository: "acme/app",
              source: {
                mount: "app",
                ref: "refs/pull/42/head",
                repo: "acme/app",
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

    const host = repositoryHostContext.read({ context })
    await expect(host.keys()).resolves.toEqual(["issue", "pullRequest"])
    await expect(host.get("pullRequest")).resolves.toMatchObject({
      headRef: "refs/pull/42/head",
      source: { ref: "refs/pull/42/head" },
    })
    expect(resolved.registries.workspaceContributions).toEqual([])
    await expect(resolved.workspace?.fs.readFile("pull-request-context/context.md")).rejects.toThrow("missing")
  })

  it("resolves GitHub issue targets lazily and exposes PR-specific keys only for pull requests", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const read = vi.fn<RepositoryHostClient["read"]>(async request => {
      if (request.operation === "issue") {
        return {
          body: "PR body",
          html_url: "https://github.test/acme/app/pull/42",
          labels: [{ name: "bug" }, { name: "ui" }],
          number: 42,
          pull_request: { html_url: "https://github.test/acme/app/pull/42", url: "https://api.github.test/repos/acme/app/pulls/42" },
          title: "Fix UI",
        }
      }
      if (request.operation === "comments") {
        return [{ body: "Looks good", id: 1, user: { login: "mona" } }]
      }
      if (request.operation === "changeRequest") {
        return {
          base: { ref: "main" },
          head: { ref: "feature", repo: { full_name: "acme/app" } },
          number: 42,
          title: "Fix UI",
        }
      }
      if (request.operation === "changeRequestFiles") {
        return [{ filename: "src/app.ts", status: "modified" }]
      }
      throw new Error(`Unexpected operation: ${request.operation}`)
    })
    const context = createAgentInvocationContextStore()

    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          client: { provider: "github", read },
          target: { repo: "acme/app", number: 42 },
        }),
      ],
    }, runtime(), {}, undefined, "read", { context })

    const host = repositoryHostContext.read({ context })
    expect(read).not.toHaveBeenCalled()
    await expect(host.keys()).resolves.toEqual(["issue", "body", "labels", "comments", "pullRequest", "files"])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenLastCalledWith({
      operation: "issue",
      target: { id: 42, kind: "issue", owner: "acme", repository: "app" },
    })
    await expect(host.pick(["body", "labels"] as const)).resolves.toEqual({
      body: "PR body",
      labels: ["bug", "ui"],
    })
    expect(read).toHaveBeenCalledTimes(1)

    await expect(Promise.all([host.get("comments"), host.get("comments")])).resolves.toEqual([
      [{ body: "Looks good", id: 1, user: { login: "mona" } }],
      [{ body: "Looks good", id: 1, user: { login: "mona" } }],
    ])
    expect(read).toHaveBeenCalledTimes(2)
    await expect(host.get("pullRequest")).resolves.toMatchObject({
      head: { ref: "feature", repo: "acme/app" },
      headRef: "feature",
      number: 42,
      repository: "acme/app",
    })
    await expect(host.get("files")).resolves.toEqual([{ filename: "src/app.ts", status: "modified" }])
    expect(read).toHaveBeenCalledTimes(4)
  })

  it("returns undefined for known absent PR keys and rejects unknown keys", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const read = vi.fn<RepositoryHostClient["read"]>(async request => {
      if (request.operation === "issue") {
        return {
          body: "Issue body",
          labels: [],
          number: 7,
          title: "Plain issue",
        }
      }
      if (request.operation === "comments") return []
      throw new Error(`Unexpected operation: ${request.operation}`)
    })
    const context = createAgentInvocationContextStore()

    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          client: { provider: "github", read },
          target: { issue: 7, repo: "acme/app" },
        }),
      ],
    }, runtime(), {}, undefined, "read", { context })

    const host = repositoryHostContext.read({ context })
    await expect(host.keys()).resolves.toEqual(["issue", "body", "labels", "comments"])
    await expect(host.get("pullRequest")).resolves.toBeUndefined()
    await expect(host.get("files")).resolves.toBeUndefined()
    await expect(host.get("wat" as never)).rejects.toThrow('Unknown repositoryHostContext() key "wat"')
    expect(() => JSON.stringify(host)).toThrow("Call resolveAll() before JSON.stringify()")
  })

  it("retries target key resolution after a transient issue read failure", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const read = vi.fn<RepositoryHostClient["read"]>(async request => {
      if (request.operation !== "issue") throw new Error(`Unexpected operation: ${request.operation}`)
      if (read.mock.calls.length === 1) throw new Error("temporarily unavailable")
      return {
        body: "Issue body",
        labels: [],
        number: 7,
        title: "Plain issue",
      }
    })
    const context = createAgentInvocationContextStore()

    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          client: { provider: "github", read },
          target: { issue: 7, repo: "acme/app" },
        }),
      ],
    }, runtime(), {}, undefined, "read", { context })

    const host = repositoryHostContext.read({ context })
    await expect(host.keys()).rejects.toThrow("temporarily unavailable")
    await expect(host.keys()).resolves.toEqual(["issue", "body", "labels", "comments"])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("preserves repository from static issue-only context", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")

    await expect(repositoryHostContext.read({
      issue: {
        number: 7,
        repository: { fullName: "acme/app" },
        title: "Plain issue",
      },
    }).get("issue")).resolves.toMatchObject({
      number: 7,
      repository: "acme/app",
      title: "Plain issue",
    })
  })

  it("keeps the old synchronous pull request reader for source and git consumers", async () => {
    const { pullRequestContext, repositoryHostContext } = await import("../src/capabilities.ts")
    const rawPullRequestContext = {
      pullRequest: {
        base: { ref: "main" },
        number: 42,
        source: {
          mount: "vitehub",
          ref: "refs/pull/42/head",
          repo: "acme/app",
        },
        title: "Review me",
      },
      repository: {
        fullName: "acme/app",
        name: "app",
        owner: "acme",
      },
      trigger: {
        actor: { login: "mona" },
        deliveryId: "delivery-1",
      },
    } as const

    expect(pullRequestContext.read({
      context: { get: (key: string) => key === "pullRequest" ? rawPullRequestContext : undefined },
    })).toMatchObject({
      headRef: "refs/pull/42/head",
      number: 42,
      repository: "acme/app",
      source: { mount: "vitehub" },
    })
    await expect(repositoryHostContext.read({
      context: { get: (key: string) => key === "pullRequest" ? rawPullRequestContext : undefined },
    }).get("issue")).resolves.toMatchObject({
      number: 42,
      pullRequest: {},
      repository: "acme/app",
      title: "Review me",
    })
  })

  it("records pullRequestContext under the legacy pullRequest key by default", async () => {
    const { pullRequestContext } = await import("../src/capabilities.ts")
    const context = createAgentInvocationContextStore()

    await resolveAgentCapabilities({
      capabilities: [
        pullRequestContext({
          context: {
            pullRequest: {
              base: { ref: "main" },
              number: 42,
              repository: "acme/app",
              source: {
                mount: "vitehub",
                ref: "refs/pull/42/head",
                repo: "acme/app",
              },
              title: "Review me",
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

    expect(pullRequestContext.read({ context })).toMatchObject({
      number: 42,
      repository: "acme/app",
      title: "Review me",
    })
    expect(context.get("pullRequest")).toMatchObject({
      headRef: "refs/pull/42/head",
      number: 42,
      repository: "acme/app",
      source: {
        mount: "vitehub",
        ref: "refs/pull/42/head",
        repo: "acme/app",
      },
      title: "Review me",
    })
    expect(context.get<{ get?: unknown }>("pullRequest")?.get).toBeUndefined()
    expect(context.get("repositoryHost")).toBeUndefined()
  })

  it("does not add repository host context when configured resolvers opt out", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const context = createAgentInvocationContextStore()
    const existing = { issue: { number: 7, repository: "acme/app" } }
    context.set("repositoryHost", existing)

    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          context: () => undefined,
          target: () => undefined,
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      context,
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(context.get("repositoryHost")).toBe(existing)

    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          target: { number: 7, repo: "acme/app" },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      context,
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(context.get("repositoryHost")).toBe(existing)

    const skippedContext = createAgentInvocationContextStore()
    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          target: () => false,
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      context: skippedContext,
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(skippedContext.get("repositoryHost")).toBeUndefined()
  })
})
