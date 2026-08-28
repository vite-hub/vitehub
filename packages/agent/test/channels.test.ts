import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { hasRuntimeType } from "../src/internal/runtime-type.ts"

function githubIssueCommentPayload(body = "/review please") {
  return {
    action: "created",
    comment: {
      body,
      id: 99,
      node_id: "comment-node",
      user: { id: 1, login: "mona", type: "User" },
    },
    issue: {
      html_url: "https://github.test/acme/app/issues/42",
      number: 42,
      pull_request: {
        html_url: "https://github.test/acme/app/pull/42",
        url: "https://api.github.test/repos/acme/app/pulls/42",
      },
      title: "Improve app",
    },
    installation: { id: 123 },
    repository: {
      full_name: "acme/app",
    },
  }
}

describe("agent channels", () => {
  it("uses normalized finish context text for default GitHub PR replies", async () => {
    const { github } = await import("../src/channels.ts")
    const channel = github({ pullRequest: true })
    const trigger = channel.triggers?.dev
    if (!trigger) throw new Error("Missing GitHub dev trigger.")

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const result = await trigger.invoke({
      capabilities: [],
      channel,
      trigger: { channelId: "github", id: "github.dev", name: "dev", source: "channel" },
    } as never, {
      pullRequest: {
        pullRequest: {
          apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
          body: "Review body",
          comments: [{ body: "Looks good", id: 100, user: { login: "hubot" } }],
          files: [{ additions: 5, deletions: 2, filename: "src/app.ts", status: "modified" }],
          labels: ["review"],
          number: 42,
          source: { mount: "app", ref: "refs/pull/42/head", repo: "acme/app" },
          title: "Improve app",
        },
        repository: { fullName: "acme/app", name: "app", owner: "acme" },
        run: { messageId: "99", origin: "github-pull-request-comment", runId: "github:acme/app#42:comment:99", threadId: "pr-42" },
        trigger: {
          action: "created",
          actor: { login: "mona" },
          args: "",
          command: "/review",
          comment: { id: 99, nodeId: "comment-node" },
          event: "issue_comment",
          installationId: 123,
        },
      },
    })
    if (result instanceof Response) throw new Error("Expected GitHub context invocation.")
    const finishEffect = result.delivery?.finishEffects
    if (!hasRuntimeType(finishEffect, "function")) throw new Error("Missing GitHub finish effect.")

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(Promise.resolve(finishEffect({
      extensions: { get: () => undefined },
      reply: (input: string) => ({ kind: "reply", payload: input }),
      result: { text: "output fallback" },
      text: "event fallback",
    } as never))).resolves.toEqual({ kind: "reply", payload: "output fallback" })
  })

  it("exposes a GitHub pull request reader for invocation context", async () => {
    const { pullRequest } = await import("../src/channels.ts")
    const context = {
      pullRequest: {
        pullRequest: {
          apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
          body: "Review body",
          comments: [{ body: "Looks good", id: 100, user: { login: "hubot" } }],
          files: [{ additions: 5, deletions: 2, filename: "src/app.ts", status: "modified" }],
          labels: ["review"],
          number: 42,
          source: { checkout: false, mount: "", ref: "refs/pull/42/head", repo: "acme/app" },
          title: "Improve app",
        },
        repository: { fullName: "acme/app", name: "app", owner: "acme" },
        run: { messageId: "99", origin: "github-pull-request-comment", runId: "github:acme/app#42:comment:99", threadId: "pr-42" },
        trigger: {
          action: "created",
          actor: { login: "mona" },
          args: "",
          command: "/review",
          comment: { id: 99 },
          event: "issue_comment",
        },
      },
    }

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    expect(pullRequest.read({
      context: {
        // SAFETY: This test fixture intentionally indexes its exact local context shape.
        get: key => context[key as keyof typeof context],
      },
    })).toMatchObject({
      body: "Review body",
      comments: [{ body: "Looks good", id: 100, user: { login: "hubot" } }],
      files: [{ additions: 5, deletions: 2, filename: "src/app.ts", status: "modified" }],
      labels: ["review"],
      number: 42,
      provider: "github",
      repository: "acme/app",
      source: { checkout: false, mount: "", ref: "refs/pull/42/head", repo: "acme/app" },
      title: "Improve app",
    })
    expect(() => pullRequest.read({ context: { get: () => undefined } })).toThrow("requires pull request invocation context")
  })

  it("configures pull request workspaces with portal, root, custom, and disabled policies", async () => {
    const { github } = await import("../src/channels.ts")
    const pullRequestContext = {
      pullRequest: {
        apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
        head: { ref: "feature", sha: "a".repeat(40) },
        number: 42,
        source: { mount: "portal", ref: "refs/pull/42/head", repo: "acme/app" },
      },
      repository: { fullName: "acme/app", name: "app", owner: "acme" },
      run: { messageId: "99", origin: "github-pull-request-comment", runId: "github:acme/app#42:comment:99", threadId: "pr-42" },
      trigger: {
        action: "created",
        actor: { login: "mona" },
        args: "",
        command: "/review",
        comment: { id: 99 },
        event: "issue_comment",
      },
    }
    const context = {
      context: {
        get: (key: string) => key === "pullRequest" ? pullRequestContext : undefined,
      },
    }

    const defaultChannel = github({ pullRequest: true })
    const defaultWorkspace = defaultChannel.capabilities?.find(capability => capability.id === "github-pull-request-workspace")?.workspace
    if (!hasRuntimeType(defaultWorkspace, "function")) throw new Error("Missing default pull request Workspace contribution.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const contribution = await defaultWorkspace(context as never)
    if (!contribution) throw new Error("Missing default pull request Workspace source.")
    expect(contribution.sources?.vitehubGitHubPullRequest).toMatchObject({
      materialize: "lazy",
      mount: { path: "portal" },
    })
    expect(contribution.sources).not.toHaveProperty("github")
    const rootChannel = github({ pullRequest: { workspace: true } })
    const rootWorkspace = rootChannel.capabilities?.find(capability => capability.id === "github-pull-request-workspace")?.workspace
    if (!hasRuntimeType(rootWorkspace, "function")) throw new Error("Missing root pull request Workspace contribution.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(rootWorkspace(context as never)).resolves.toMatchObject({
      sources: { vitehubGitHubPullRequest: { mount: { path: "" } } },
    })

    const customChannel = github({ pullRequest: { workspace: { mount: "repository" } } })
    const customWorkspace = customChannel.capabilities?.find(capability => capability.id === "github-pull-request-workspace")?.workspace
    if (!hasRuntimeType(customWorkspace, "function")) throw new Error("Missing custom pull request Workspace contribution.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(customWorkspace(context as never)).resolves.toMatchObject({
      sources: { vitehubGitHubPullRequest: { mount: { path: "repository" } } },
    })

    const sourceMountChannel = github({ pullRequest: { sourceMount: "legacy-repository" } })
    const sourceMountWorkspace = sourceMountChannel.capabilities?.find(capability => capability.id === "github-pull-request-workspace")?.workspace
    if (!hasRuntimeType(sourceMountWorkspace, "function")) throw new Error("Missing source-mount pull request Workspace contribution.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(sourceMountWorkspace(context as never)).resolves.toMatchObject({
      sources: { vitehubGitHubPullRequest: { mount: { path: "legacy-repository" } } },
    })

    const disabledChannel = github({ pullRequest: { workspace: false } })
    expect(disabledChannel.capabilities).toEqual([])

    const nonPullRequestChannel = github()
    expect(nonPullRequestChannel.capabilities).toEqual([])
  })

  it("rejects pull request workspace mounts outside the Workspace", async () => {
    const { github } = await import("../src/channels.ts")
    expect(() => github({ pullRequest: { workspace: { mount: "../portal" } } }))
      .toThrow("workspace mount must stay inside the Workspace")
    expect(() => github({ pullRequest: { workspace: { mount: "C:\\portal" } } }))
      .toThrow("workspace mount must stay inside the Workspace")
  })

  it("creates Discord adapters from provider defaults", async () => {
    vi.resetModules()
    const createDiscordAdapter = vi.fn(() => ({ name: "discord" }))
    vi.doMock("@chat-adapter/discord", () => ({ createDiscordAdapter }))
    try {
      const { discord } = await import("../src/channels.ts")
      const channel = discord({
        adapter: {
          applicationId: "app-id",
          botToken: { unseal: () => "bot-token" },
          mentionRoleIds: ["role-1"],
          publicKey: { unseal: () => "public-key" },
          userName: "support",
        },
      })

      if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Discord adapter resolver.")
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      await expect(channel.adapter({} as never)).resolves.toEqual({ name: "discord" })
      expect(createDiscordAdapter).toHaveBeenCalledWith({
        applicationId: "app-id",
        botToken: "bot-token",
        mentionRoleIds: ["role-1"],
        publicKey: "public-key",
        userName: "support",
      })
    }
    finally {
      vi.doUnmock("@chat-adapter/discord")
      vi.resetModules()
    }
  })

  it("creates Telegram adapters and webhook verification from Telegram options", async () => {
    vi.resetModules()
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    try {
      const { telegram } = await import("../src/channels.ts")
      const channel = telegram({
        allowedUserIds: async () => ["123"],
        botToken: () => ({ unseal: () => "bot-token" }),
        mode: "webhook",
        userName: "support",
        webhookSecret: () => ({ unseal: () => "webhook-secret" }),
      })

      if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      await expect(channel.adapter({} as never)).resolves.toEqual({ name: "telegram" })
      expect(createTelegramAdapter).toHaveBeenCalledWith({
        allowedUserIds: ["123"],
        botToken: "bot-token",
        mode: "webhook",
        secretToken: "webhook-secret",
        userName: "support",
      })

      const webhooks = channel.webhooks
      if (!webhooks || !hasRuntimeType(webhooks, "object") || Array.isArray(webhooks)) {
        throw new Error("Expected Telegram webhook registration.")
      }
      expect(webhooks.secretHeader).toBe("x-telegram-bot-api-secret-token")
      if (!hasRuntimeType(webhooks.secretToken, "function")) throw new Error("Expected webhook secret resolver.")
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      await expect(Promise.resolve(webhooks.secretToken({} as never))).resolves.toBe("webhook-secret")
    }
    finally {
      vi.doUnmock("@chat-adapter/telegram")
      vi.resetModules()
    }
  })

  it("uses standard Telegram environment bindings when options are omitted", async () => {
    vi.resetModules()
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    try {
      const { telegram } = await import("../src/channels.ts")
      const channel = telegram()
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      const context = {
        cloudflare: {
          env: {
            TELEGRAM_BOT_TOKEN: "bot-token",
            TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
          },
        },
      } as never

      if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
      await expect(channel.adapter(context)).resolves.toEqual({ name: "telegram" })
      expect(createTelegramAdapter).toHaveBeenCalledWith({
        botToken: "bot-token",
        secretToken: "webhook-secret",
      })

      const webhooks = channel.webhooks
      if (!webhooks || !hasRuntimeType(webhooks, "object") || Array.isArray(webhooks)) {
        throw new Error("Expected Telegram webhook registration.")
      }
      if (!hasRuntimeType(webhooks.secretToken, "function")) throw new Error("Expected webhook secret resolver.")
      vi.stubGlobal("process", undefined)
      await expect(Promise.resolve(webhooks.secretToken(context))).resolves.toBe("webhook-secret")
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      await expect(Promise.resolve(webhooks.secretToken({ cloudflare: { env: {} } } as never))).resolves.toBeUndefined()
    }
    finally {
      vi.unstubAllGlobals()
      vi.doUnmock("@chat-adapter/telegram")
      vi.resetModules()
    }
  })

  it("uses polling Telegram channels without a webhook route", async () => {
    const { telegram } = await import("../src/channels.ts")
    expect(telegram({ mode: "polling" }).webhooks).toBe(false)
  })

  it("rejects ambiguous Telegram webhook configuration", async () => {
    const { telegram } = await import("../src/channels.ts")
    expect(() => telegram({
      webhookSecret: "provider-secret",
      webhooks: { secretToken: "route-secret" },
    })).toThrow("accepts webhookSecret or webhooks, not both")
  })

  it("marks Discord adapters for long-content splitting without passing ViteHub options through", async () => {
    vi.resetModules()
    const adapter = { name: "discord" }
    const createDiscordAdapter = vi.fn(() => adapter)
    vi.doMock("@chat-adapter/discord", () => ({ createDiscordAdapter }))
    try {
      const { discord } = await import("../src/channels.ts")
      const channel = discord({
        adapter: {
          botToken: "bot-token",
          longContent: { mode: "split" },
        },
      })

      if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Discord adapter resolver.")
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      const resolved = await channel.adapter({} as never)
      expect(resolved).toBe(adapter)
      expect(createDiscordAdapter).toHaveBeenCalledWith({ botToken: "bot-token" })
      expect(Reflect.get(resolved, Symbol.for("vitehub.discord.longContent.mode"))).toBe("split")
    }
    finally {
      vi.doUnmock("@chat-adapter/discord")
      vi.resetModules()
    }
  })

  it("adds Discord thread title support when a bot token is available", async () => {
    vi.resetModules()
    const adapter = { name: "discord" }
    const createDiscordAdapter = vi.fn(() => adapter)
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    vi.doMock("@chat-adapter/discord", () => ({ createDiscordAdapter }))
    try {
      const { discord } = await import("../src/channels.ts")
      const channel = discord({
        adapter: {
          apiUrl: "https://discord.test/api",
          applicationId: "app-id",
          botToken: { unseal: () => "bot-token" },
          publicKey: "public-key",
        },
      })

      if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Discord adapter resolver.")
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      const resolved = await channel.adapter({} as never) as { setThreadTitle?: (threadId: string, title: string) => Promise<void> }
      expect(resolved).toBe(adapter)
      expect(hasRuntimeType(resolved.setThreadTitle, "function")).toBe(true)

      await resolved.setThreadTitle?.("discord:guild:channel:thread-1", "  New   Thread   Title  ")
      const longTitle = `ERROR: ${"x".repeat(120)}`
      await resolved.setThreadTitle?.("discord:guild:channel:thread-1", longTitle)

      expect(fetch).toHaveBeenNthCalledWith(1, "https://discord.test/api/channels/thread-1", {
        body: JSON.stringify({ name: "New Thread Title" }),
        headers: {
          Authorization: "Bot bot-token",
          "Content-Type": "application/json",
        },
        method: "PATCH",
      })
      expect(fetch).toHaveBeenNthCalledWith(2, "https://discord.test/api/channels/thread-1", {
        body: JSON.stringify({ name: longTitle.slice(0, 100) }),
        headers: {
          Authorization: "Bot bot-token",
          "Content-Type": "application/json",
        },
        method: "PATCH",
      })
    }
    finally {
      vi.unstubAllGlobals()
      vi.doUnmock("@chat-adapter/discord")
      vi.resetModules()
    }
  })

  it("publishes explicit Workspace artifacts", async () => {
    const { publishWorkspaceArtifacts } = await import("../src/channels.ts")
    const content = new Uint8Array([1, 2, 3])
    const readFile = vi.fn(async () => content)
    const stat = vi.fn(async () => ({ mediaType: "image/png", path: "screenshots/login.png", type: "file" as const }))
    const publish = vi.fn(async () => ({ url: "https://assets.example/review/screenshots/login.png" }))

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(publishWorkspaceArtifacts({
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      workspace: {
        fs: { readFile, stat },
      } as never,
    }, [{
      alt: "Login badge",
      path: "./screenshots/login.png",
      placement: "inline",
    }], {
      prefix: "review",
      publish,
    })).resolves.toEqual([{
      alt: "Login badge",
      mediaType: "image/png",
      path: "screenshots/login.png",
      placement: "inline",
      url: "https://assets.example/review/screenshots/login.png",
    }])

    expect(readFile).toHaveBeenCalledWith("screenshots/login.png", { encoding: "binary" })
    expect(publish).toHaveBeenCalledWith({
      artifact: {
        alt: "Login badge",
        mediaType: "image/png",
        path: "screenshots/login.png",
        placement: "inline",
      },
      content,
      mediaType: "image/png",
      pathname: "review/screenshots/login.png",
    })
  })

  it("rejects unsafe Workspace artifact paths before publishing", async () => {
    const { publishWorkspaceArtifacts } = await import("../src/channels.ts")
    const publish = vi.fn()

    await expect(publishWorkspaceArtifacts({
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      workspace: {
        fs: {
          readFile: vi.fn(),
          stat: vi.fn(),
        },
      } as never,
    }, [{ path: "../secret.png" }], { publish })).rejects.toThrow("Delivery artifact path must stay inside the workspace")
    expect(publish).not.toHaveBeenCalled()
  })

  it("maps published delivery artifacts to Chat SDK attachments", async () => {
    const { deliveryArtifactAttachments } = await import("../src/delivery-artifacts.ts")

    expect(deliveryArtifactAttachments([{
      mediaType: "image/png",
      path: "screenshots/login.png",
      placement: "inline",
      url: "https://assets.example/screenshots/login.png",
    }, {
      mediaType: "application/pdf",
      path: "reports/review.pdf",
      placement: "attachment",
      url: "https://assets.example/reports/review.pdf",
    }, {
      mediaType: "image/png",
      path: "screenshots/link-only.png",
      placement: "link",
      url: "https://assets.example/screenshots/link-only.png",
    }, {
      path: "local-only.txt",
    }])).toEqual([{
      mimeType: "image/png",
      name: "login.png",
      type: "image",
      url: "https://assets.example/screenshots/login.png",
    }, {
      mimeType: "application/pdf",
      name: "review.pdf",
      type: "file",
      url: "https://assets.example/reports/review.pdf",
    }])
  })

  it("rewrites only explicit Markdown references for published artifacts", async () => {
    const { rewriteDeliveryArtifactMarkdown } = await import("../src/delivery-artifacts.ts")

    expect(rewriteDeliveryArtifactMarkdown([
      "![Preview](./artifacts/preview.png)",
      "![Absolute](/workspace/codex-session/artifacts/preview.png)",
      "![Nested absolute](/workspace/codex-session/tmp/artifacts/preview.png)",
      "[Report](artifacts/report.pdf)",
      "[App docs](/docs/artifacts/report.pdf)",
      "[Root artifact](/artifacts/report.pdf)",
      "Bare path: artifacts/preview.png",
      "Outside: ![Other](other/preview.png)",
    ].join("\n"), [{
      path: "artifacts/preview.png",
      url: "https://assets.example/preview.png",
    }, {
      path: "artifacts/report.pdf",
      url: "https://assets.example/report.pdf",
    }])).toBe([
      "![Preview](<https://assets.example/preview.png>)",
      "![Absolute](<https://assets.example/preview.png>)",
      "![Nested absolute](/workspace/codex-session/tmp/artifacts/preview.png)",
      "[Report](<https://assets.example/report.pdf>)",
      "[App docs](/docs/artifacts/report.pdf)",
      "[Root artifact](/artifacts/report.pdf)",
      "Bare path: artifacts/preview.png",
      "Outside: ![Other](other/preview.png)",
    ].join("\n"))
  })

  it("accepts GitHub issue_comment payloads without delivery facts", async () => {
    const { github } = await import("../src/channels.ts")
    const channel = github({ pullRequest: { reply: false } })
    const trigger = channel.triggers?.webhook
    if (!trigger) throw new Error("Missing GitHub webhook trigger.")
    const context = {
      capabilities: [],
      channel,
      trigger: { channelId: "github", id: "github.webhook", name: "webhook", source: "channel" },
    }

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const result = await trigger.invoke(context as never, { payload: githubIssueCommentPayload() })
    if (result instanceof Response) throw new Error("Expected GitHub webhook invocation.")

    expect(result.input.context?.github).toMatchObject({
      args: "please",
      command: "/review",
      installationId: 123,
      repository: "acme/app",
    })
    expect(result.input.context?.pullRequest).toMatchObject({
      pullRequest: { number: 42 },
      repository: { fullName: "acme/app" },
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const withEmptyFacts = await trigger.invoke(context as never, { payload: githubIssueCommentPayload("/review generated route"), github: {} })
    if (withEmptyFacts instanceof Response) throw new Error("Expected GitHub webhook invocation with empty facts.")
    expect(withEmptyFacts.input.context?.github).toMatchObject({
      args: "generated route",
      command: "/review",
      installationId: 123,
      repository: "acme/app",
    })
  })

  it("fetches public pull request head metadata without a token", async () => {
    const { github } = await import("../src/channels.ts")
    const tokenKeys = ["VITEHUB_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const
    const previousTokens = Object.fromEntries(tokenKeys.map(key => [key, process.env[key]]))
    tokenKeys.forEach(key => delete process.env[key])
    try {
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).not.toHaveProperty("authorization")
        return Response.json({
          base: { ref: "main", repo: { full_name: "acme/app" }, sha: "base-sha" },
          head: { ref: "feature", repo: { full_name: "acme/fork" }, sha: "head-sha" },
        })
      })
      const channel = github({
        // SAFETY: This test fixture intentionally supplies a Fetch-compatible mock.
        app: { fetch: fetcher as typeof fetch },
        pullRequest: { reply: false },
      })
      const trigger = channel.triggers?.webhook
      if (!trigger) throw new Error("Missing GitHub webhook trigger.")

      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      const result = await trigger.invoke({
        capabilities: [],
        channel,
        trigger: { channelId: "github", id: "github.webhook", name: "webhook", source: "channel" },
      } as never, { payload: githubIssueCommentPayload() })
      if (result instanceof Response) throw new Error("Expected GitHub webhook invocation.")

      expect(result.input.context?.pullRequest).toMatchObject({
        pullRequest: {
          head: { ref: "feature", repo: "acme/fork", sha: "head-sha" },
          number: 42,
          source: { ref: "refs/pull/42/head" },
        },
      })
    }
    finally {
      tokenKeys.forEach((key) => {
        const value = previousTokens[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
    }
  })

  it("uses token fallback to fetch GitHub PR metadata", async () => {
    const { github } = await import("../src/channels.ts")
    const previousToken = process.env.VITEHUB_GITHUB_TOKEN
    process.env.VITEHUB_GITHUB_TOKEN = "metadata-token"
    try {
      const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url)
        expect(init?.headers).toMatchObject({ authorization: "Bearer metadata-token" })
        if (href.endsWith("/pulls/42")) {
          return Response.json({
            base: { ref: "main", repo: { full_name: "acme/app" }, sha: "base-sha" },
            body: "metadata body",
            head: { ref: "feature", repo: { full_name: "acme/fork" }, sha: "head-sha" },
          })
        }
        if (href.includes("/issues/42/comments")) {
          if (new URL(href).searchParams.get("page")) return Response.json([])
          return Response.json([{ body: "comment body", html_url: "https://github.test/acme/app/pull/42#issuecomment-1", id: 1 }])
        }
        if (href.includes("/pulls/42/files")) {
          if (new URL(href).searchParams.get("page")) return Response.json([])
          return Response.json([{ filename: "src/app.ts", status: "modified" }])
        }
        throw new Error(`Unexpected GitHub API call: ${href}`)
      })
      const channel = github({
        app: {
          apiBaseUrl: "https://api.github.test",
          // SAFETY: This test fixture intentionally supplies a Fetch-compatible mock.
          fetch: fetcher as typeof fetch,
        },
        pullRequest: { reply: false },
      })
      const trigger = channel.triggers?.webhook
      if (!trigger) throw new Error("Missing GitHub webhook trigger.")

      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      const result = await trigger.invoke({
        capabilities: [],
        channel,
        trigger: { channelId: "github", id: "github.webhook", name: "webhook", source: "channel" },
      } as never, { payload: githubIssueCommentPayload() })
      if (result instanceof Response) throw new Error("Expected GitHub webhook invocation.")

      expect(result.input.context?.pullRequest).toMatchObject({
        pullRequest: {
          base: { ref: "main", repo: "acme/app", sha: "base-sha" },
          body: "metadata body",
          comments: [{ body: "comment body", id: 1 }],
          files: [{ filename: "src/app.ts", status: "modified" }],
          head: { ref: "feature", repo: "acme/fork", sha: "head-sha" },
          number: 42,
          source: { mount: "portal", ref: "refs/pull/42/head", repo: "acme/app" },
        },
      })
      expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain("https://api.github.test/app/installations/123/access_tokens")
    }
    finally {
      if (previousToken === undefined) delete process.env.VITEHUB_GITHUB_TOKEN
      else process.env.VITEHUB_GITHUB_TOKEN = previousToken
    }
  })

  it("marks disabled pull request workspaces in invocation context", async () => {
    const { github } = await import("../src/channels.ts")
    const channel = github({
      app: {
        // SAFETY: This test fixture intentionally supplies a Fetch-compatible mock.
        fetch: (async () => Response.json({
          base: { ref: "main", repo: { full_name: "acme/app" }, sha: "base-sha" },
          head: { ref: "feature", repo: { full_name: "acme/fork" }, sha: "head-sha" },
        })) as typeof fetch,
      },
      pullRequest: { workspace: false },
    })
    const trigger = channel.triggers?.webhook
    if (!trigger) throw new Error("Missing GitHub webhook trigger.")

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const result = await trigger.invoke({
      capabilities: [],
      channel,
      trigger: { channelId: "github", id: "github.webhook", name: "webhook", source: "channel" },
    } as never, { payload: githubIssueCommentPayload() })
    if (result instanceof Response) throw new Error("Expected GitHub webhook invocation.")

    expect(result.input.context?.pullRequest).toMatchObject({
      pullRequest: {
        source: {
          checkout: false,
          mount: "app",
        },
      },
    })
  })

  it("invokes GitHub PR dev trigger from context and raw payload", async () => {
    const { github } = await import("../src/channels.ts")
    const channel = github({ pullRequest: true })
    const trigger = channel.triggers?.dev
    if (!trigger) throw new Error("Missing GitHub dev trigger.")
    expect(trigger.webhooks).toEqual([])
    const context = {
      capabilities: [],
      channel,
      trigger: { channelId: "github", id: "github.dev", name: "dev", source: "channel" },
    }
    const pullRequest = {
      pullRequest: {
        apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
        number: 42,
        source: { mount: "app", ref: "refs/pull/42/head", repo: "acme/app" },
      },
      repository: { fullName: "acme/app", name: "app", owner: "acme" },
      run: { messageId: "99", origin: "github-pull-request-comment", runId: "github:acme/app#42:comment:99", threadId: "pr-42" },
      trigger: {
        action: "created",
        actor: { login: "mona" },
        args: "docs",
        command: "/review",
        comment: { id: 99, nodeId: "comment-node" },
        event: "issue_comment",
        installationId: 123,
      },
    }
    const devRun = { origin: "dev", runId: "dev:from-loop", threadId: "dev:agent" }

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const fromContext = await trigger.invoke(context as never, { pullRequest, run: devRun })
    if (fromContext instanceof Response) throw new Error("Expected GitHub context invocation.")
    expect(fromContext.input).toMatchObject({
      context: {
        github: {
          commentId: 99,
          commentNodeId: "comment-node",
          command: "/review",
          installationId: 123,
          repository: "acme/app",
        },
        pullRequest,
      },
      prompt: "/review docs",
    })
    expect(fromContext.run).toMatchObject({
      channelId: "github",
      origin: "github-pull-request-comment",
      runId: "github:acme/app#42:comment:99",
      threadId: "pr-42",
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const blocked = await trigger.invoke({
      ...context,
      agentCapabilities: [{ metadata: { commands: { review: { channels: ["other"] } }, trigger: "/" } }],
    } as never, { pullRequest })
    if (!(blocked instanceof Response)) throw new Error("Expected blocked GitHub context response.")
    await expect(blocked.json()).resolves.toMatchObject({ reason: "not_command" })

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const fromPayload = await trigger.invoke(context as never, { ...githubIssueCommentPayload("/review raw payload"), run: devRun })
    if (fromPayload instanceof Response) throw new Error("Expected GitHub payload invocation.")
    expect(fromPayload.input.context?.github).toMatchObject({
      args: "raw payload",
      command: "/review",
      installationId: 123,
      repository: "acme/app",
    })
    expect(fromPayload.input.context?.pullRequest).toMatchObject({
      pullRequest: { number: 42 },
      repository: { fullName: "acme/app" },
    })
    expect(fromPayload.run).toMatchObject({
      channelId: "github",
      origin: "github-pull-request-comment",
      runId: "github:acme/app#42:comment:99",
      threadId: "https://github.test/acme/app/pull/42",
    })
  })

  it("rewrites published image references in GitHub PR reviews", async () => {
    const { github } = await import("../src/channels.ts")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" }).toString()
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return Response.json({ expires_at: new Date(Date.now() + 600_000).toISOString(), token: "installation-token" })
      }
      return Response.json({ ok: true }, { status: 201 })
    })
    const channel = github({
      app: {
        apiBaseUrl: "https://api.github.test",
        appId: "1",
        // SAFETY: This test fixture intentionally supplies a Fetch-compatible mock.
        fetch: fetcher as typeof fetch,
        installationId: 123,
        privateKey: privateKeyPem,
      },
    })
    const reviewEffect = channel.effects?.review
    if (!hasRuntimeType(reviewEffect, "function")) throw new Error("Missing GitHub review effect.")

    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await reviewEffect({
      channel,
      effect: {
        artifacts: [{
          alt: "Login badge",
          mediaType: "image/png",
          path: "screenshots/login.png",
          placement: "inline",
          url: "https://assets.example/review/screenshots/login.png",
        }],
        kind: "review",
        payload: { body: "Review body\n\n![Login badge](/workspace/codex-session/screenshots/login.png)" },
      },
      input: {
        context: {
          github: {
            action: "created",
            actor: { login: "onmax" },
            args: "",
            body: "/review",
            command: "/review",
            commentId: 99,
            installationId: 123,
            issueNumber: 42,
            owner: "vite-hub",
            pullRequestUrl: "https://api.github.test/repos/vite-hub/vitehub/pulls/42",
            repo: "vitehub",
            repository: "vite-hub/vitehub",
          },
        },
        prompt: "/review",
      },
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    } as never)

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.test/repos/vite-hub/vitehub/pulls/42/reviews",
      expect.objectContaining({
        body: JSON.stringify({
          body: "Review body\n\n![Login badge](<https://assets.example/review/screenshots/login.png>)",
          event: "COMMENT",
        }),
        headers: expect.objectContaining({ authorization: "Bearer installation-token" }),
        method: "POST",
      }),
    )
  })

  it("publishes Workspace image paths before posting GitHub PR replies", async () => {
    const { github, messageChannelDeliveredReplyBody } = await import("../src/channels.ts")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" }).toString()
    const postedBodies: string[] = []
    const createdRefs: Array<Record<string, unknown>> = []
    const uploadedPaths: string[] = []
    const uploadedBodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith("/app/installations/456/access_tokens")) {
        return Response.json({ expires_at: new Date(Date.now() + 600_000).toISOString(), token: "installation-token" })
      }
      if (href.endsWith("/git/ref/heads/review-assets")) return Response.json({ message: "not found" }, { status: 404 })
      if (href.endsWith("/pulls/42")) return Response.json({ base: { sha: "base-sha" }, head: { sha: "head-sha" } })
      if (href.endsWith("/git/refs")) {
        createdRefs.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true }, { status: 201 })
      }
      if (href.includes("/contents/")) {
        uploadedPaths.push(href)
        uploadedBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ content: { sha: "content-sha" } }, { status: 201 })
      }
      if (href.endsWith("/issues/42/comments")) {
        postedBodies.push(JSON.parse(String(init?.body)).body)
        return Response.json({ ok: true }, { status: 201 })
      }
      throw new Error(`Unexpected GitHub API call: ${href}`)
    })
    const channel = github({
      app: {
        apiBaseUrl: "https://api.github.test",
        appId: "2",
        artifacts: { branch: "review-assets", pathPrefix: "review-output" },
        // SAFETY: This test fixture intentionally supplies a Fetch-compatible mock.
        fetch: fetcher as typeof fetch,
        installationId: 456,
        privateKey: privateKeyPem,
      },
    })
    const replyEffect = channel.effects?.reply
    if (!hasRuntimeType(replyEffect, "function")) throw new Error("Missing GitHub reply effect.")

    const effect = {
      kind: "reply" as const,
      payload: { body: "Screenshot: screenshots/login.png\nAngled: ![login](<screenshots/login.png>)\nRoot: result.png\nLink: [result](result.png)\nAngle link: [result](<result.png>)\nInline: ![result](result.png)\nQuery: ![query](screenshots/login.png?raw=1)\nFragment: ![fragment](result.png#v1)\nHTML: <img src=\"screenshots/login.png\" width=\"400\">\nCode: `unused.png`" },
    }
    // SAFETY: The fixture supplies the complete delivery context consumed by the GitHub reply effect.
    const deliveryContext = {
      channel,
      effect,
      input: {
        context: {
          github: {
            action: "created",
            actor: { login: "onmax" },
            args: "",
            body: "/review",
            command: "/review",
            commentId: 99,
            installationId: 456,
            issueNumber: 42,
            owner: "vite-hub",
            pullRequestUrl: "https://api.github.test/repos/vite-hub/vitehub/pulls/42",
            repo: "vitehub",
            repository: "vite-hub/vitehub",
          },
        },
        prompt: "/review",
      },
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
      workspace: {
        fs: {
          readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
          stat: vi.fn(async (path: string) => ({ mediaType: "image/png", path, type: "file" as const })),
        },
      },
    } as never
    await replyEffect(deliveryContext)

    expect(createdRefs).toEqual([{
      ref: "refs/heads/review-assets",
      sha: "base-sha",
    }])
    expect(uploadedPaths).toHaveLength(2)
    const contentPaths = uploadedPaths.map(path => decodeURIComponent(path.split("/contents/")[1]!)).sort()
    expect(contentPaths[0]).toMatch(/^review-output\/pr-42\/run-1\/\d+-\d+-[a-f0-9]{12}\/result\.png$/)
    expect(contentPaths[1]).toMatch(/^review-output\/pr-42\/run-1\/screenshots\/\d+-\d+-[a-f0-9]{12}\/login\.png$/)
    expect(uploadedBodies.map(body => body.branch)).toEqual(["review-assets", "review-assets"])
    expect(uploadedBodies.map(body => body.message).sort()).toEqual([
      "chore: publish agent delivery artifact result.png [skip ci]",
      "chore: publish agent delivery artifact screenshots/login.png [skip ci]",
    ])
    expect(postedBodies).toHaveLength(1)
    expect(postedBodies[0]).toContain("Screenshot: ![login.png](<https://github.test/vite-hub/vitehub/raw/review-assets/")
    expect(postedBodies[0]).toContain("Angled: ![login](<https://github.test/vite-hub/vitehub/raw/review-assets/")
    expect(postedBodies[0]).toContain("Root: ![result.png](<https://github.test/vite-hub/vitehub/raw/review-assets/")
    expect(postedBodies[0]).toContain("Link: [result](<https://github.test/vite-hub/vitehub/raw/review-assets/")
    expect(postedBodies[0]).toContain("Angle link: [result](<https://github.test/vite-hub/vitehub/raw/review-assets/")
    expect(postedBodies[0]).toContain("Inline: ![result](<https://github.test/vite-hub/vitehub/raw/review-assets/")
    expect(postedBodies[0]).toContain("Query: ![query](screenshots/login.png?raw=1)")
    expect(postedBodies[0]).toContain("Fragment: ![fragment](result.png#v1)")
    expect(postedBodies[0]).toContain("HTML: <img src=\"screenshots/login.png\" width=\"400\">")
    expect(postedBodies[0]).toContain("Code: `unused.png`")
    expect(postedBodies[0]).not.toContain("Screenshot: screenshots/login.png")
    expect(postedBodies[0]).not.toContain("Root: result.png")
    expect(postedBodies[0]).not.toContain("[result](![")
    expect(messageChannelDeliveredReplyBody(deliveryContext)).toBe(postedBodies[0])
  })

  it("isolates rewritten GitHub reply bodies for overlapping delivery contexts", async () => {
    const { github, messageChannelDeliveredReplyBody } = await import("../src/channels.ts")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" }).toString()
    const postedBodies: string[] = []
    let releaseFirstPost!: () => void
    const firstPostReleased = new Promise<void>(resolve => { releaseFirstPost = resolve })
    let firstPostStarted!: () => void
    const firstPostPending = new Promise<void>(resolve => { firstPostStarted = resolve })
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith("/app/installations/457/access_tokens")) {
        return Response.json({ expires_at: new Date(Date.now() + 600_000).toISOString(), token: "installation-token" })
      }
      if (href.endsWith("/git/ref/heads/review-assets")) return Response.json({ object: { sha: "branch-sha" } })
      if (href.includes("/contents/")) return Response.json({ content: { sha: "content-sha" } }, { status: 201 })
      if (href.endsWith("/issues/42/comments")) {
        // SAFETY: This mocked GitHub endpoint receives the JSON comment body created by the reply effect.
        const body = JSON.parse(String(init?.body)).body as string
        postedBodies.push(body)
        if (postedBodies.length === 1) {
          firstPostStarted()
          await firstPostReleased
        }
        return Response.json({ ok: true }, { status: 201 })
      }
      throw new Error(`Unexpected GitHub API call: ${href}`)
    })
    const channel = github({
      app: {
        apiBaseUrl: "https://api.github.test",
        appId: "2",
        artifacts: { branch: "review-assets", pathPrefix: "review-output" },
        // SAFETY: This test fixture intentionally supplies a Fetch-compatible mock.
        fetch: fetcher as typeof fetch,
        installationId: 457,
        privateKey: privateKeyPem,
      },
    })
    const replyEffect = channel.effects?.reply
    if (!hasRuntimeType(replyEffect, "function")) throw new Error("Missing GitHub reply effect.")

    const effect = {
      kind: "reply" as const,
      payload: { body: "Result: result.png" },
    }
    // SAFETY: The fixture supplies the complete delivery context consumed by the GitHub reply effect.
    const deliveryContext = (runId: string) => ({
      channel,
      effect,
      input: {
        context: {
          github: {
            action: "created",
            actor: { login: "onmax" },
            args: "",
            body: "/review",
            command: "/review",
            commentId: 99,
            installationId: 457,
            issueNumber: 42,
            owner: "vite-hub",
            pullRequestUrl: "https://api.github.test/repos/vite-hub/vitehub/pulls/42",
            repo: "vitehub",
            repository: "vite-hub/vitehub",
          },
        },
        prompt: "/review",
      },
      memo: vi.fn(),
      run: { runId },
      runtime: "unknown",
      waitUntil: vi.fn(),
      workspace: {
        fs: {
          readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
          stat: vi.fn(async (path: string) => ({ mediaType: "image/png", path, type: "file" as const })),
        },
      },
    }) as never
    const firstContext = deliveryContext("run-first")
    const secondContext = deliveryContext("run-second")

    const firstDelivery = replyEffect(firstContext)
    await firstPostPending
    await replyEffect(secondContext)
    releaseFirstPost()
    await firstDelivery

    expect(postedBodies).toHaveLength(2)
    expect(postedBodies[0]).toContain("/run-first/")
    expect(postedBodies[1]).toContain("/run-second/")
    expect(messageChannelDeliveredReplyBody(firstContext)).toBe(postedBodies[0])
    expect(messageChannelDeliveredReplyBody(secondContext)).toBe(postedBodies[1])
  })

  it("normalizes hand-written GitHub PR status string payloads", async () => {
    const { github } = await import("../src/channels.ts")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" }).toString()
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-github-app-key-"))
    const privateKeyPath = join(rootDir, "app.pem")
    const statusBodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith("/app/installations/789/access_tokens")) {
        return Response.json({ expires_at: new Date(Date.now() + 600_000).toISOString(), token: "installation-token" })
      }
      if (href.endsWith("/pulls/42")) return Response.json({ base: { sha: "base-sha" }, head: { sha: "head-sha" } })
      if (href.endsWith("/statuses/head-sha")) {
        statusBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true }, { status: 201 })
      }
      throw new Error(`Unexpected GitHub API call: ${href}`)
    })
    try {
      await writeFile(privateKeyPath, privateKeyPem, "utf8")
      const channel = github({
        app: {
          apiBaseUrl: "https://api.github.test",
          appId: "4",
          // SAFETY: This test fixture intentionally supplies a Fetch-compatible mock.
          fetch: fetcher as typeof fetch,
          installationId: 789,
          privateKeyPath,
          statusContext: "ViteHub Test",
        },
      })
      const statusEffect = channel.effects?.status
      if (!hasRuntimeType(statusEffect, "function")) throw new Error("Missing GitHub status effect.")

      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      await statusEffect({
        channel,
        effect: {
          kind: "status",
          payload: "success",
        },
        input: {
          context: {
            github: {
              action: "created",
              actor: { login: "onmax" },
              args: "",
              body: "/review",
              command: "/review",
              commentId: 99,
              installationId: 789,
              issueNumber: 42,
              owner: "vite-hub",
              pullRequestUrl: "https://api.github.test/repos/vite-hub/vitehub/pulls/42",
              repo: "vitehub",
              repository: "vite-hub/vitehub",
            },
          },
          prompt: "/review",
        },
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      } as never)

      expect(statusBodies).toEqual([{
        context: "ViteHub Test",
        state: "success",
      }])
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("ignores GitHub PR delivery effects without pull request context", async () => {
    const { github } = await import("../src/channels.ts")
    const channel = github({
      app: {
        appId: "3",
        // SAFETY: This test fixture intentionally supplies a Fetch-compatible mock.
        fetch: vi.fn() as typeof fetch,
      },
    })

    for (const kind of ["reply", "update", "review"] as const) {
      const effect = channel.effects?.[kind]
      if (!hasRuntimeType(effect, "function")) throw new Error(`Missing GitHub ${kind} effect.`)
      // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
      await expect(effect({
        channel,
        effect: { kind, payload: { body: "No GitHub context" } },
        input: { prompt: "No GitHub context" },
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      } as never)).resolves.toBeUndefined()
    }
  })
})
