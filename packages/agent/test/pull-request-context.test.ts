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
  it("requires an explicit workspace when contributing custom sources", async () => {
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
      driver: { run: () => "ok", },
    })).toThrow("pull-request-context() requires an explicit workspace")
  })

  it("supports context-only usage without a workspace", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { pullRequestContext } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [
        pullRequestContext({
          context: {
            number: 42,
            repository: "acme/app",
          },
        }),
      ],
      driver: { run: ({ context }) => context.get("pullRequest"), },
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toEqual({
      number: 42,
      repository: "acme/app",
    })
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
            head: { ref: "feature" },
            number: 42,
            repository: "acme/app",
          },
          rules: {
            "artifacts/review/**": { write: true },
          },
          sources: ({ context }) => {
            const pullRequest = context.get("pullRequest") as { number: number } | undefined
            return {
              pullRequest: {
                materialize: "lazy",
                mount: "pull-request",
                async getKeys() {
                  return ["body.md"]
                },
                async getItem(key: string) {
                  return {
                    content: `PR ${pullRequest?.number} body`,
                    key,
                    mediaType: "text/markdown",
                  }
                },
              },
            }
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
      head: { ref: "feature" },
      headRef: "feature",
      number: 42,
      repository: "acme/app",
    })
    await expect(resolved.workspace?.fs.readFile("pull-request/body.md")).resolves.toBe("PR 42 body")
    expect(resolved.registries.workspaceContributions).toEqual([
      {
        capabilityId: "pull-request-context",
        rules: ["artifacts/review/**"],
        sources: ["pullRequestContext", "pullRequest"],
      },
    ])
  })

  it("renders pull request context as markdown frontmatter in the workspace", async () => {
    const { pullRequestContext } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        pullRequestContext({
          context: {
            base: { ref: "main" },
            head: { ref: "feature" },
            number: 42,
            provider: "github",
            repository: "acme/app",
            trigger: {
              actor: { login: "mona" },
              deliveryId: "delivery-1",
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("pull-request-context/context.md")).resolves.toContain([
      "---",
      'repository: "acme/app"',
      "number: 42",
      'provider: "github"',
      'base: {"ref":"main"}',
      'head: {"ref":"feature"}',
      'deliveryId: "delivery-1"',
      "---",
      "",
      "# Pull Request Context",
    ].join("\n"))
    await expect(resolved.workspace?.fs.readFile("pull-request-context/context.json")).resolves.toContain('"deliveryId": "delivery-1"')
    await expect(resolved.workspace?.fs.readFile("pull-request-context/diff.md")).rejects.toThrow("Workspace file does not exist")
  })

  it("renders built-in GitHub pull request context values", async () => {
    const { pullRequestContext } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const rawPullRequestContext = {
      pullRequest: {
        apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
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
      run: {
        messageId: "100",
        origin: "github-pull-request-comment",
        runId: "delivery-1",
        threadId: "thread",
      },
      trigger: {
        action: "created",
        actor: { login: "mona" },
        args: "",
        command: "/review",
        comment: { id: 100 },
        deliveryId: "delivery-1",
        event: "issue_comment",
      },
    } as const

    const resolved = await resolveAgentCapabilities({
      capabilities: [pullRequestContext()],
    }, runtime(), {
      context: {
        pullRequest: rawPullRequestContext,
      },
    }, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("pull-request-context/context.md")).resolves.toContain([
      "---",
      'repository: "acme/app"',
      "number: 42",
      'provider: "github"',
      'source: {"mount":"vitehub","ref":"refs/pull/42/head","repo":"acme/app"}',
      'base: {"ref":"main"}',
      'head: {"ref":"refs/pull/42/head"}',
      'deliveryId: "delivery-1"',
      "---",
      "",
      "# Pull Request Context",
      "",
      "Change Request 42 in acme/app.",
    ].join("\n"))

    const json = JSON.parse(await resolved.workspace!.fs.readFile("pull-request-context/context.json"))
    expect(json).toMatchObject({
      base: { ref: "main" },
      number: 42,
      provider: "github",
      repository: "acme/app",
      run: { runId: "delivery-1" },
      source: {
        mount: "vitehub",
        ref: "refs/pull/42/head",
        repo: "acme/app",
      },
      title: "Review me",
      trigger: {
        actor: { login: "mona" },
        deliveryId: "delivery-1",
      },
    })
    expect(pullRequestContext.read({
      context: { get: (key: string) => key === "pullRequest" ? rawPullRequestContext : undefined },
    })).toMatchObject({
      number: 42,
      repository: "acme/app",
      source: { mount: "vitehub" },
    })
  })

  it("renders GitHub metadata gaps and bounded untrusted comments", async () => {
    const { pullRequestContext } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [pullRequestContext()],
    }, runtime(), {
      context: {
        pullRequest: {
          pullRequest: {
            apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
            body: "PR body\n[truncated 8 characters]",
            comments: [{
              body: "Looks risky.\n[truncated 20 characters]",
              id: 1,
              user: { login: "mona" },
            }],
            files: [{
              additions: 1,
              deletions: 0,
              filename: "src/app.ts",
              status: "modified",
            }],
            metadata: {
              omittedComments: 2,
              omittedFiles: 1,
              unavailable: "[vitehub] GitHub metadata request failed with 403.",
            },
            number: 42,
            source: {
              mount: "app",
              ref: "refs/pull/42/head",
              repo: "acme/app",
            },
          },
          repository: {
            fullName: "acme/app",
            name: "app",
            owner: "acme",
          },
          run: {
            messageId: "100",
            origin: "github-pull-request-comment",
            runId: "delivery-1",
            threadId: "thread",
          },
          trigger: {
            action: "created",
            actor: { login: "mona" },
            args: "",
            command: "/review",
            comment: { id: 100 },
            event: "issue_comment",
          },
        },
      },
    }, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    const markdown = await resolved.workspace?.fs.readFile("pull-request-context/context.md")

    expect(markdown).toContain("PR metadata unavailable: [vitehub] GitHub metadata request failed with 403.")
    expect(markdown).toContain("## Body\n\nPR body\n[truncated 8 characters]")
    expect(markdown).toContain("- src/app.ts (modified) (+1/-0)\n\n+1 more files not shown.")
    expect(markdown).toContain("## Comments (untrusted user content)")
    expect(markdown).toContain("- mona: Looks risky.\n[truncated 20 characters]")
    expect(markdown).toContain("- +2 more comments not shown.")
  })

  it("grants the default source to the selected Workspace Scope", async () => {
    const { access, pullRequestContext } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "review",
            scopes: {
              review: { paths: ["src"] },
            },
          },
        }),
        pullRequestContext({
          context: {
            number: 42,
            repository: "acme/app",
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("pull-request-context/context.md")).resolves.toContain("Change Request 42 in acme/app.")
  })

  it("grants the default source to an inline Workspace Scope selection", async () => {
    const { access, pullRequestContext } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: {
              paths: ["src"],
              scope: "review",
            },
          },
        }),
        pullRequestContext({
          context: {
            number: 42,
            repository: "acme/app",
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("pull-request-context/context.md")).resolves.toContain("Change Request 42 in acme/app.")
  })

  it("rejects custom sources that reuse the default source key", async () => {
    const { pullRequestContext } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        pullRequestContext({
          context: {
            number: 42,
            repository: "acme/app",
          },
          sources: {
            pullRequestContext: {
              async getKeys() {
                return ["context.md"]
              },
              async getItem(key: string) {
                return { content: "replacement", key }
              },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('sources cannot use reserved Workspace Source key "pullRequestContext"')
  })

  it("uses custom capability ids for default source identity", async () => {
    const { pullRequestContext } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        pullRequestContext({
          context: {
            number: 1,
            repository: "acme/first",
          },
          contextKey: "firstPullRequest",
          id: "first-pull-request",
        }),
        pullRequestContext({
          context: {
            number: 2,
            repository: "acme/second",
          },
          contextKey: "secondPullRequest",
          id: "second-pull-request",
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("first-pull-request/context.md")).resolves.toContain("Change Request 1 in acme/first.")
    await expect(resolved.workspace?.fs.readFile("second-pull-request/context.md")).resolves.toContain("Change Request 2 in acme/second.")
    expect(resolved.registries.workspaceContributions).toEqual([
      {
        capabilityId: "first-pull-request",
        rules: [],
        sources: ["first-pull-request-context"],
      },
      {
        capabilityId: "second-pull-request",
        rules: [],
        sources: ["second-pull-request-context"],
      },
    ])
  })

  it("rejects duplicate pull request context values before resolving trusted context", async () => {
    const { pullRequestContext } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        pullRequestContext({
          context: {
            number: 42,
            repository: "trusted/repo",
          },
        }),
      ],
    }, runtime(), {
      context: {
        pullRequest: {
          number: 1,
          repository: "caller/repo",
        },
      } as never,
    })).rejects.toThrow('Invocation context value "pullRequest" is already set')
  })
})
