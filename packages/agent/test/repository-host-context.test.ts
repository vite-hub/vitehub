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
  it("requires the Vite plugin to compile materialization path strings", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          materialize: "./PULL_REQUEST.template.md",
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      context: createAgentInvocationContextStore(),
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow("materialize paths require the ViteHub Agent plugin")
  })

  it("omits materialization when configured resolvers opt out", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const workspaceDefinition = {
      name: "review",
      sources: {},
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          materialize: {
            path: "PULL_REQUEST.md",
            template: () => "# Pull request",
          },
          target: () => false,
        } as never),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      context: createAgentInvocationContextStore(),
      driverKind: "harness",
      workspaceDefinition,
    })

    expect(resolved.workspaceDefinition).toEqual(workspaceDefinition)
    expect(resolved.workspaceMaterializationPaths).toEqual(["PULL_REQUEST.md"])
  })

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

  it("preserves pull request context from static GitHub issue payloads", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const context = createAgentInvocationContextStore()

    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          context: {
            issue: {
              body: "PR body",
              html_url: "https://github.test/acme/app/pull/42",
              labels: [{ name: "bug" }],
              number: 42,
              pull_request: {
                html_url: "https://github.test/acme/app/pull/42",
                url: "https://api.github.test/repos/acme/app/pulls/42",
              },
              repository: "acme/app",
              title: "Fix UI",
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
    await expect(host.keys()).resolves.toEqual(["issue", "pullRequest", "body", "labels"])
    await expect(host.get("pullRequest")).resolves.toMatchObject({
      body: "PR body",
      htmlUrl: "https://github.test/acme/app/pull/42",
      labels: ["bug"],
      number: 42,
      repository: "acme/app",
      title: "Fix UI",
    })
  })

  it("preserves nested pull request URLs from static issue payloads without issue URLs", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const context = createAgentInvocationContextStore()

    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          context: {
            issue: {
              number: 42,
              pullRequest: {
                apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
                htmlUrl: "https://github.test/acme/app/pull/42",
              },
              repository: "acme/app",
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
    await expect(host.get("pullRequest")).resolves.toMatchObject({
      apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
      htmlUrl: "https://github.test/acme/app/pull/42",
      number: 42,
      repository: "acme/app",
    })
  })

  it("preserves pull request context from static GitHub issue comment payloads", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const host = repositoryHostContext.read({
      action: "created",
      comment: { body: "/review", id: 99, user: { login: "mona" } },
      issue: {
        body: "PR body",
        html_url: "https://github.test/acme/app/pull/42",
        number: 42,
        pull_request: {
          html_url: "https://github.test/acme/app/pull/42",
          url: "https://api.github.test/repos/acme/app/pulls/42",
        },
        title: "Fix UI",
      },
      repository: { full_name: "acme/app" },
    })

    await expect(host.keys()).resolves.toEqual(["issue", "pullRequest", "body"])
    await expect(host.get("issue")).resolves.toMatchObject({
      number: 42,
      pullRequest: {
        apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
        htmlUrl: "https://github.test/acme/app/pull/42",
      },
      repository: "acme/app",
    })
    await expect(host.get("pullRequest")).resolves.toMatchObject({
      body: "PR body",
      htmlUrl: "https://github.test/acme/app/pull/42",
      number: 42,
      repository: "acme/app",
      title: "Fix UI",
    })
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
          apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
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
      apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
      head: { ref: "feature", repo: "acme/app" },
      headRef: "feature",
      number: 42,
      repository: "acme/app",
    })
    await expect(host.get("files")).resolves.toEqual([{ filename: "src/app.ts", status: "modified" }])
    expect(read).toHaveBeenCalledTimes(4)
  })

  it("preserves target pull request API URLs from issue fallback metadata", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const read = vi.fn<RepositoryHostClient["read"]>(async request => {
      if (request.operation === "issue") {
        return {
          body: "PR body",
          number: 42,
          pull_request: {
            url: "https://api.github.test/repos/acme/app/pulls/42",
          },
          title: "Fix UI",
        }
      }
      if (request.operation === "changeRequest") {
        return {
          body: "PR body from change request",
          number: 42,
          title: "Fix UI",
        }
      }
      throw new Error(`Unexpected operation: ${request.operation}`)
    })
    const context = createAgentInvocationContextStore()

    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext({
          client: { provider: "github", read },
          target: { pullRequest: 42, repo: "acme/app" },
        }),
      ],
    }, runtime(), {}, undefined, "read", { context })

    await expect(repositoryHostContext.read({ context }).get("pullRequest")).resolves.toMatchObject({
      apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
      body: "PR body from change request",
      number: 42,
      repository: "acme/app",
    })
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
    await expect(host.has("labels")).resolves.toBe(true)
    await expect(host.get("labels")).resolves.toEqual([])
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

    const host = repositoryHostContext.read({
      issue: {
        labels: [],
        number: 7,
        repository: { fullName: "acme/app" },
        title: "Plain issue",
      },
    })

    await expect(host.get("issue")).resolves.toMatchObject({
      number: 7,
      repository: "acme/app",
      title: "Plain issue",
    })
    await expect(host.get("labels")).resolves.toEqual([])
  })

  it("normalizes pull request data in static repository host context", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const rawPullRequestContext = {
      number: 999,
      pull_request: {
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
        full_name: "acme/app",
        name: "app",
        owner: "acme",
      },
      trigger: {
        actor: { login: "mona" },
        deliveryId: "delivery-1",
      },
    } as const

    await expect(repositoryHostContext.read({
      context: { get: (key: string) => key === "pullRequest" ? rawPullRequestContext : undefined },
    }).get("issue")).resolves.toMatchObject({
      number: 42,
      pullRequest: {},
      repository: "acme/app",
      title: "Review me",
    })
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

    expect(context.get("repositoryHost")).not.toBe(existing)
    await expect(repositoryHostContext.read({ context }).get("issue")).resolves.toEqual(existing.issue)

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

    await expect(repositoryHostContext.read({ context }).get("issue")).resolves.toEqual(existing.issue)

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

  it("does not synthesize an absent custom context from pull request data", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const context = createAgentInvocationContextStore()
    context.set("pullRequest", {
      number: 42,
      repository: "acme/app",
    })

    await expect(repositoryHostContext.read({ context }, "customRepositoryHost").keys()).resolves.toEqual([])
    await expect(repositoryHostContext.read({ pullRequest: context.get("pullRequest") }, "customRepositoryHost").keys()).resolves.toEqual([])
  })

  it("wraps preseeded repository host context", async () => {
    const { repositoryHostContext } = await import("../src/capabilities.ts")
    const context = createAgentInvocationContextStore()
    context.set("repositoryHost", {
      pullRequest: {
        number: 42,
        repository: "acme/app",
        title: "Review me",
      },
    })

    await resolveAgentCapabilities({
      capabilities: [
        repositoryHostContext(),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      context,
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    const host = context.get("repositoryHost")
    expect(host).toHaveProperty("get")
    expect(repositoryHostContext.read(host)).toBe(host)
    await expect(repositoryHostContext.read({ context }).get("pullRequest")).resolves.toMatchObject({
      number: 42,
      repository: "acme/app",
      title: "Review me",
    })
  })
})
