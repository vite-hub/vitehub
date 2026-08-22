import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { refreshWorkspaceDevToken, workspaceDevTokenHeader } from "@vite-hub/workspace/server"
import { describe, expect, it, vi } from "vitest"

import { createAgentCliContributor, runAgentDevCli, runAgentEvalCli, runAgentInfoCli, runAgentInvocationsCli } from "../src/cli.ts"
import { runAgentChannelHistoryCli } from "../src/internal/channel-history-cli.ts"
import { channelRegistration, runAgentChannelSyncCli } from "../src/internal/channel-sync-cli.ts"
import { getAgentChannelSyncDefinition } from "../src/internal/channel-sync.ts"
import { createAgentEvaliteConfigPath, writeAgentEvaliteConfig } from "../src/internal/evalite-config.ts"
import { createTelegramChannelSyncProvider } from "../src/internal/telegram-channel-sync.ts"
import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue } from "../src/invocation-stream.ts"
import { telegram } from "../src/channels.ts"

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

function ndjson(events: unknown[]): Response {
  return new Response(`${events.map(event => JSON.stringify(event)).join("\n")}\n`, {
    headers: { "content-type": "application/x-ndjson" },
  })
}

const unknownExecutionAuthorityFixture = {
  credentials: "unknown",
  environment: "unknown",
  filesystem: { access: "unknown", scope: "unknown" },
  isolation: "unknown",
  network: "unknown",
  processes: "unknown",
} as const

describe("agent CLI", () => {
  it("contributes the agent eval feature", () => {
    expect(createAgentCliContributor({ rootDir: join(import.meta.dirname, "fixtures") })).toEqual({
      namespaces: [{
        description: "Agent development workflows.",
        features: [
          expect.objectContaining({ name: "eval" }),
          expect.objectContaining({ name: "info" }),
          expect.objectContaining({ name: "dev" }),
          expect.objectContaining({ name: "invocations" }),
        ],
        name: "agent",
      }, {
        description: "External Channel registration workflows.",
        features: [expect.objectContaining({ name: "history" }), expect.objectContaining({ name: "sync" })],
        name: "channels",
      }],
    })
  })

  it("keeps the agent dev feature without executable eval files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-cli-no-evals-"))
    expect(createAgentCliContributor({ rootDir })).toEqual({
      namespaces: [{
        description: "Agent development workflows.",
        features: [
          expect.objectContaining({ name: "info" }),
          expect.objectContaining({ name: "dev" }),
          expect.objectContaining({ name: "invocations" }),
        ],
        name: "agent",
      }, {
        description: "External Channel registration workflows.",
        features: [expect.objectContaining({ name: "history" }), expect.objectContaining({ name: "sync" })],
        name: "channels",
      }],
    })
    await rm(rootDir, { force: true, recursive: true })
  })

  it("leaves custom Telegram adapter registration application-owned", () => {
    const channel = telegram({ adapter: () => ({}) as never })
    expect(getAgentChannelSyncDefinition(channel)).toBeUndefined()
  })

  it("preserves Telegram synchronization when a Channel is decorated", async () => {
    const channel = { ...telegram({ botToken: "bot-token" }), capabilities: [] }
    const definition = getAgentChannelSyncDefinition(channel)
    expect(definition).toMatchObject({ provider: "telegram" })
    await expect(definition!.resolve({} as never, channel)).resolves.toMatchObject({
      mode: "webhook",
    })
  })

  it("resolves Telegram synchronization from decorated lifecycle fields", async () => {
    const base = telegram({ botToken: "bot-token", webhookSecret: "old-secret" })
    const channel = {
      ...base,
      webhooks: { ...base.webhooks as object, secretToken: "new-secret" },
    }
    const sync = await getAgentChannelSyncDefinition(channel)!.resolve({} as never, channel)
    const bodies: Record<string, unknown>[] = []
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return Response.json({ ok: true, result: { pending_update_count: 0, url: "https://example.com/webhook" } })
    })

    await sync!.apply({
      action: "create",
      current: { url: "" },
      desired: { url: "https://example.com/webhook" },
    }, fetcher as never)

    expect(bodies[0]).toMatchObject({ secret_token: "new-secret" })
  })

  it("drops inherited Telegram synchronization when decoration replaces the adapter", async () => {
    const base = telegram({ botToken: "bot-token" })
    const channel = { ...base, adapter: () => ({}) as never }

    await expect(
      getAgentChannelSyncDefinition(channel)!.resolve({} as never, channel),
    ).resolves.toBeUndefined()
  })

  it("prints a sanitized Telegram webhook plan without applying it", async () => {
    const stdout = stream()
    const stderr = stream()
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
      }
      expect(url).toContain("/botsecret-bot-token/getWebhookInfo")
      return Response.json({ ok: true, result: { pending_update_count: 2, url: "" } })
    })

    const exitCode = await runAgentChannelSyncCli([
      "--stage", "staging",
      "--url", "https://staging.example.com",
      "--json",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout,
    }, {
      fetch: fetcher as never,
      loadTargets: async () => [{
        agent: "calories",
        channel: "telegram",
        mode: "webhook",
        provider: "telegram",
        registration: { id: "telegram" },
        sync: createTelegramChannelSyncProvider({
          botToken: "secret-bot-token",
          mode: "webhook",
          secretToken: "secret-webhook-token",
        }),
      }],
    })

    expect(exitCode).toBe(0)
    expect(stderr.output()).toBe("")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(stdout.output()).not.toContain("secret-bot-token")
    expect(stdout.output()).not.toContain("secret-webhook-token")
    expect(JSON.parse(stdout.output())).toMatchObject({
      mode: "dry-run",
      origin: "https://staging.example.com",
      registrations: [{
        action: "create",
        agent: "calories",
        applied: false,
        channel: "telegram",
        desired: {
          secretToken: "configured",
          url: "https://staging.example.com/api/_vitehub/agents/calories/webhooks/telegram",
        },
        preflight: "verified",
        provider: "telegram",
      }],
      schemaVersion: 1,
      stage: "staging",
    })
  })

  it("downloads Channel history and materializes attachments", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-channel-history-"))
    const stdout = stream()
    const stderr = stream()
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://example.com/api/_vitehub/agents/calories/webhooks/telegram")
      if (init?.method === "HEAD") {
        expect(new Headers(init.headers).has("x-test-secret")).toBe(false)
        return new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
      }
      const headers = new Headers(init?.headers)
      expect(headers.get("x-vitehub-channel-history")).toBe("1")
      expect(headers.get("x-test-secret")).toBe("webhook-secret")
      expect(init?.body).toBe(JSON.stringify({ threadId: "telegram:123" }))
      return Response.json({
        messages: [{
          attachments: [{ data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/jpeg", name: "meal.jpg", type: "image" }],
          formatted: { data: "preserve me", type: "text" },
          id: "1",
          text: "Lunch",
          threadId: "telegram:123",
        }],
        schemaVersion: 1,
        threadId: "telegram:123",
      })
    })
    try {
      const exitCode = await runAgentChannelHistoryCli([
        "--stage", "production",
        "--url", "https://example.com",
        "--output", "archives/export",
      ], {
        cwd: rootDir,
        env: {},
        rootDir,
        stderr,
        stdout,
      }, {
        fetch: fetcher as never,
        loadTargets: async () => [{
          agent: "calories",
          channel: "telegram",
          defaultThreadId: "telegram:123",
          mode: "webhook",
          provider: "telegram",
          registration: { id: "telegram", secretHeader: "x-test-secret", secretToken: "webhook-secret" },
        }],
      })

      expect(exitCode).toBe(0)
      expect(stderr.output()).toBe("")
      expect(stdout.output()).toContain("Downloaded 1 messages")
      await expect(readFile(join(rootDir, "archives/export/media/0001-meal.jpg"))).resolves.toEqual(Buffer.from([1, 2, 3]))
      await expect(readFile(join(rootDir, "archives/export/history.json"), "utf8")).resolves.toContain('"file": "media/0001-meal.jpg"')
      await expect(readFile(join(rootDir, "archives/export/history.json"), "utf8")).resolves.toContain('"data": "preserve me"')
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("selects a webhook registration for Channel history", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-channel-history-webhook-"))
    const loadTargets = vi.fn(async () => [{
      agent: "calories",
      channel: "telegram",
      mode: "webhook" as const,
      provider: "telegram",
      registration: { id: "secondary", secretHeader: "x-test-secret", secretToken: "webhook-secret" },
    }])
    try {
      const exitCode = await runAgentChannelHistoryCli([
        "--stage", "production",
        "--url", "https://example.com",
        "--output", "export",
        "--thread", "telegram:123",
        "--webhook", "secondary",
      ], {
        cwd: rootDir,
        env: {},
        rootDir: "/repo",
        stderr: stream(),
        stdout: stream(),
      }, {
        fetch: async (_input, init) => init?.method === "HEAD"
          ? new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
          : Response.json({ messages: [], schemaVersion: 1, threadId: "telegram:123" }),
        loadTargets,
      })

      expect(exitCode).toBe(0)
      expect(loadTargets).toHaveBeenCalledWith(expect.objectContaining({ registration: "secondary" }))
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("uses deployed webhook IDs when selecting Channel history registrations", async () => {
    const channel = {
      kind: "http",
      webhooks: [
        { path: "/first", secretToken: "first" },
        { path: "/second", secretToken: "second" },
      ],
    } as never

    await expect(channelRegistration("support", channel, {}, "support-2")).resolves.toMatchObject({
      id: "support-2",
      path: "/second",
      secretToken: "second",
    })
    await expect(channelRegistration("support", channel, {}, "support"))
      .rejects.toThrow("no unique webhook registration named support")
    await expect(channelRegistration("support", { kind: "http", webhooks: { id: "primary" } } as never, {}, "other"))
      .rejects.toThrow("no unique webhook registration named other")
    await expect(channelRegistration("support", { kind: "http", webhooks: { id: "primary" } } as never, {}, "other", true))
      .resolves.toBeUndefined()
  })

  it("publishes Channel history atomically and preserves existing output", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-channel-history-lifecycle-"))
    const stdout = stream()
    const stderr = stream()
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }))
    const target = {
      agent: "calories",
      channel: "telegram",
      defaultThreadId: "telegram:123",
      mode: "webhook" as const,
      provider: "telegram",
      registration: { id: "telegram", secretHeader: "x-test-secret", secretToken: "webhook-secret" },
    }
    const loadTargets = vi.fn(async () => [target])
    const run = async () => await runAgentChannelHistoryCli([
      "--stage", "production",
      "--thread", "telegram:123",
      "--url", "https://example.com",
      "--output", "archives/export",
    ], {
      cwd: rootDir,
      env: {},
      rootDir,
      stderr,
      stdout,
    }, {
      fetch: fetcher as never,
      loadTargets,
    })

    try {
      await expect(run()).resolves.toBe(1)
      expect(loadTargets).toHaveBeenCalledWith(expect.objectContaining({ resolveDefaultThread: false }))
      await expect(readdir(join(rootDir, "archives"))).resolves.toEqual([])

      await mkdir(join(rootDir, "archives/export"))
      await writeFile(join(rootDir, "archives/export/existing.txt"), "keep")
      await expect(run()).resolves.toBe(1)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await expect(readFile(join(rootDir, "archives/export/existing.txt"), "utf8")).resolves.toBe("keep")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("cleans aborted exports and preserves one concurrent winner", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-channel-history-concurrent-"))
    const target = {
      agent: "calories",
      channel: "telegram",
      defaultThreadId: "telegram:123",
      mode: "webhook" as const,
      provider: "telegram",
      registration: { id: "telegram", secretHeader: "x-test-secret", secretToken: "webhook-secret" },
    }
    const run = async (fetcher: typeof fetch) => await runAgentChannelHistoryCli([
      "--stage", "production",
      "--url", "https://example.com",
      "--output", "export",
    ], {
      cwd: rootDir,
      env: {},
      rootDir,
      stderr: stream(),
      stdout: stream(),
    }, {
      fetch: fetcher,
      loadTargets: async () => [target],
    })

    try {
      await expect(run(async () => {
        throw new DOMException("timed out", "TimeoutError")
      })).resolves.toBe(1)
      await expect(readdir(rootDir)).resolves.toEqual([])

      let started = 0
      let release!: () => void
      const bothStarted = new Promise<void>((resolve) => { release = resolve })
      const concurrentFetch = (marker: string) => async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "HEAD") return new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
        started += 1
        if (started === 2) release()
        await bothStarted
        return Response.json({ marker, messages: [], schemaVersion: 1, threadId: "telegram:123" })
      }
      const results = await Promise.all([
        run(concurrentFetch("first")),
        run(concurrentFetch("second")),
      ])
      expect(results.sort()).toEqual([0, 1])
      await expect(readdir(rootDir)).resolves.toEqual(["export"])
      const published = JSON.parse(await readFile(join(rootDir, "export/history.json"), "utf8")) as { marker: string }
      expect(["first", "second"]).toContain(published.marker)
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("redacts Telegram credentials from provider errors", async () => {
    const stderr = stream()
    const exitCode = await runAgentChannelSyncCli([
      "--stage", "staging",
      "--url", "https://staging.example.com",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => init?.method === "HEAD"
        ? new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
        : Response.json({ description: "bot-secret and webhook-secret are invalid", ok: false }, { status: 401 })) as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "webhook",
        provider: "telegram",
        registration: { id: "telegram" },
        sync: createTelegramChannelSyncProvider({
          botToken: "bot-secret",
          mode: "webhook",
          secretToken: "webhook-secret",
        }),
      }],
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("[redacted]")
    expect(stderr.output()).not.toContain("bot-secret")
    expect(stderr.output()).not.toContain("webhook-secret")
  })

  it("redacts credentials embedded in provider webhook URLs", async () => {
    const stdout = stream()
    const exitCode = await runAgentChannelSyncCli([
      "--stage", "production",
      "--url", "https://example.com",
      "--json",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => init?.method === "HEAD"
        ? new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
        : Response.json({ ok: true, result: { pending_update_count: 0, url: "https://example.com/legacy/secret-token?key=query-secret" } })) as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "webhook",
        provider: "telegram",
        registration: { id: "telegram" },
        sync: createTelegramChannelSyncProvider({ botToken: "bot-token", mode: "webhook" }),
      }],
    })

    expect(exitCode).toBe(0)
    expect(stdout.output()).not.toContain("secret-token")
    expect(stdout.output()).not.toContain("query-secret")
    expect(JSON.parse(stdout.output()).registrations[0].current.url).toBe("https://example.com/[redacted]")
  })

  it("redacts credentials embedded in configured desired webhook URLs", async () => {
    const stdout = stream()
    const exitCode = await runAgentChannelSyncCli([
      "--stage", "production",
      "--url", "https://example.com",
      "--json",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => init?.method === "HEAD"
        ? new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
        : Response.json({ ok: true, result: { pending_update_count: 0, url: "" } })) as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "webhook",
        provider: "telegram",
        registration: { id: "telegram", path: "/webhooks/admission-secret?key=query-secret" },
        sync: createTelegramChannelSyncProvider({ botToken: "bot-token", mode: "webhook" }),
      }],
    })

    expect(exitCode).toBe(0)
    expect(stdout.output()).not.toContain("admission-secret")
    expect(stdout.output()).not.toContain("query-secret")
    expect(JSON.parse(stdout.output()).registrations[0].desired.url).toBe("https://example.com/[redacted]")
  })

  it("redacts credentials embedded in failed preflight URLs", async () => {
    const stderr = stream()
    const exitCode = await runAgentChannelSyncCli([
      "--stage", "production",
      "--url", "https://example.com",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, {
      fetch: (async () => new Response(null, { status: 404 })) as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "webhook",
        provider: "telegram",
        registration: { id: "telegram", path: "/webhooks/admission-secret?key=query-secret" },
        sync: createTelegramChannelSyncProvider({ botToken: "bot-token", mode: "webhook" }),
      }],
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("https://example.com/[redacted]")
    expect(stderr.output()).not.toContain("admission-secret")
    expect(stderr.output()).not.toContain("query-secret")
  })

  it("redacts credentials embedded in failed provider verification URLs", async () => {
    const stderr = stream()
    const exitCode = await runAgentChannelSyncCli([
      "--stage", "production",
      "--url", "https://example.com",
      "--apply",
      "--confirm-origin", "https://example.com",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, {
      fetch: (async () => new Response(null, {
        headers: { "x-vitehub-channel-provider": "telegram" },
        status: 204,
      })) as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "webhook",
        provider: "telegram",
        registration: { id: "telegram", path: "/webhooks/admission-secret?key=query-secret" },
        sync: {
          apply: async () => ({ url: "https://example.com/normalized" }),
          mode: "webhook",
          plan: async ({ desiredUrl }) => ({
            action: "create",
            current: { url: "" },
            desired: { url: desiredUrl },
          }),
        },
      }],
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("https://example.com/[redacted]")
    expect(stderr.output()).not.toContain("admission-secret")
    expect(stderr.output()).not.toContain("query-secret")
  })

  it("requires exact origin confirmation before loading an apply plan", async () => {
    const stderr = stream()
    const loadTargets = vi.fn(async () => [])
    const exitCode = await runAgentChannelSyncCli([
      "--stage", "production",
      "--url", "https://app.example.com",
      "--apply",
      "--confirm-origin", "https://preview.example.com",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, { loadTargets })

    expect(exitCode).toBe(1)
    expect(loadTargets).not.toHaveBeenCalled()
    expect(stderr.output()).toContain("--confirm-origin must exactly match --url")
  })

  it("applies a validated Telegram webhook plan without exposing secrets", async () => {
    const stdout = stream()
    let registeredUrl = ""
    const requests: Array<{ body?: string, method?: string, url: string }> = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ body: typeof init?.body === "string" ? init.body : undefined, method: init?.method, url })
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
      }
      if (url.endsWith("/getWebhookInfo")) {
        return Response.json({ ok: true, result: { pending_update_count: 0, url: registeredUrl } })
      }
      if (url.endsWith("/setWebhook")) {
        registeredUrl = JSON.parse(String(init?.body)).url
        return Response.json({ ok: true, result: true })
      }
      throw new Error(`Unexpected Telegram request: ${url}`)
    })

    const exitCode = await runAgentChannelSyncCli([
      "--stage", "production",
      "--url", "https://app.example.com",
      "--apply",
      "--confirm-origin", "https://app.example.com",
      "--json",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, {
      fetch: fetcher as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "webhook",
        provider: "telegram",
        registration: { id: "telegram" },
        sync: createTelegramChannelSyncProvider({ botToken: "bot-token", mode: "webhook", secretToken: "webhook-token" }),
      }],
    })

    expect(exitCode).toBe(0)
    expect(stdout.output()).not.toContain("bot-token")
    expect(stdout.output()).not.toContain("webhook-token")
    expect(JSON.parse(stdout.output()).registrations[0]).toMatchObject({ action: "create", applied: true })
    const setWebhook = requests.find(request => request.url.endsWith("/setWebhook"))
    expect(JSON.parse(setWebhook?.body || "{}")).toEqual({
      allowed_updates: ["message"],
      drop_pending_updates: false,
      secret_token: "webhook-token",
      url: "https://app.example.com/api/_vitehub/agents/support/webhooks/telegram",
    })
  })

  it("requires deletion permission before disabling a provider webhook", async () => {
    const stderr = stream()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/getWebhookInfo")) {
        return Response.json({ ok: true, result: { pending_update_count: 0, url: "https://app.example.com/hook" } })
      }
      throw new Error(`Unexpected mutation: ${url}`)
    })

    const exitCode = await runAgentChannelSyncCli([
      "--stage", "production",
      "--url", "https://app.example.com",
      "--apply",
      "--confirm-origin", "https://app.example.com",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, {
      fetch: fetcher as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "disabled",
        provider: "telegram",
        sync: createTelegramChannelSyncProvider({ botToken: "bot-token", mode: "disabled" }),
      }],
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("requires deletion; rerun with --allow-delete")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("binds deletion confirmation to the current provider origin", async () => {
    const stderr = stream()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/getWebhookInfo")) {
        return Response.json({ ok: true, result: { pending_update_count: 0, url: "https://production.example.com/hook" } })
      }
      throw new Error(`Unexpected mutation: ${url}`)
    })

    const exitCode = await runAgentChannelSyncCli([
      "--stage", "staging",
      "--url", "https://staging.example.com",
      "--apply",
      "--allow-delete",
      "--confirm-origin", "https://staging.example.com",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, {
      fetch: fetcher as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "disabled",
        provider: "telegram",
        sync: createTelegramChannelSyncProvider({ botToken: "bot-token", mode: "disabled" }),
      }],
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("delete targets https://production.example.com")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("validates every deletion against the confirmed origin before mutation", async () => {
    const stderr = stream()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/botstaging-bot/")) {
        return Response.json({ ok: true, result: { url: "https://staging.example.com/hook" } })
      }
      if (url.includes("/botproduction-bot/")) {
        return Response.json({ ok: true, result: { url: "https://production.example.com/hook" } })
      }
      throw new Error(`Unexpected mutation: ${url}`)
    })

    const exitCode = await runAgentChannelSyncCli([
      "--stage", "staging",
      "--url", "https://staging.example.com",
      "--apply",
      "--allow-delete",
      "--confirm-origin", "https://staging.example.com",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, {
      fetch: fetcher as never,
      loadTargets: async () => [
        {
          agent: "support",
          channel: "staging",
          mode: "disabled",
          provider: "telegram",
          sync: createTelegramChannelSyncProvider({ botToken: "staging-bot", mode: "disabled" }),
        },
        {
          agent: "support",
          channel: "production",
          mode: "disabled",
          provider: "telegram",
          sync: createTelegramChannelSyncProvider({ botToken: "production-bot", mode: "disabled" }),
        },
      ],
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("delete targets https://production.example.com")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("binds webhook updates to the current provider origin", async () => {
    const stderr = stream()
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
      }
      if (url.endsWith("/getWebhookInfo")) {
        return Response.json({ ok: true, result: { url: "https://production.example.com/hook" } })
      }
      throw new Error(`Unexpected mutation: ${url}`)
    })

    const exitCode = await runAgentChannelSyncCli([
      "--stage", "staging",
      "--url", "https://staging.example.com",
      "--apply",
      "--confirm-origin", "https://staging.example.com",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, {
      fetch: fetcher as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "webhook",
        provider: "telegram",
        registration: { id: "telegram" },
        sync: createTelegramChannelSyncProvider({ botToken: "bot-token", mode: "webhook" }),
      }],
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("update targets https://production.example.com")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("rejects Channels targeting the same provider resource before planning", async () => {
    const stderr = stream()
    const fetcher = vi.fn()
    const exitCode = await runAgentChannelSyncCli([
      "--stage", "production",
      "--url", "https://app.example.com",
      "--apply",
      "--confirm-origin", "https://app.example.com",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, {
      fetch: fetcher as never,
      loadTargets: async () => [
        {
          agent: "support",
          channel: "alerts",
          mode: "webhook",
          provider: "telegram",
          registration: { id: "alerts" },
          sync: createTelegramChannelSyncProvider({ botToken: "shared-bot", mode: "webhook" }),
        },
        {
          agent: "support",
          channel: "chat",
          mode: "webhook",
          provider: "telegram",
          registration: { id: "chat" },
          sync: createTelegramChannelSyncProvider({ botToken: "shared-bot", mode: "webhook" }),
        },
      ],
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("target the same telegram resource")
    expect(stderr.output()).not.toContain("shared-bot")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("deletes and verifies a Telegram webhook only with explicit permission", async () => {
    const stdout = stream()
    let registeredUrl = "https://app.example.com/hook"
    const deleteBodies: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/getWebhookInfo")) {
        return Response.json({ ok: true, result: { pending_update_count: 3, url: registeredUrl } })
      }
      if (url.endsWith("/deleteWebhook")) {
        deleteBodies.push(String(init?.body))
        registeredUrl = ""
        return Response.json({ ok: true, result: true })
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const exitCode = await runAgentChannelSyncCli([
      "--stage", "production",
      "--url", "https://app.example.com",
      "--apply",
      "--allow-delete",
      "--confirm-origin", "https://app.example.com",
      "--json",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, {
      fetch: fetcher as never,
      loadTargets: async () => [{
        agent: "support",
        channel: "telegram",
        mode: "disabled",
        provider: "telegram",
        sync: createTelegramChannelSyncProvider({ botToken: "bot-token", mode: "disabled" }),
      }],
    })

    expect(exitCode).toBe(0)
    expect(deleteBodies.map(body => JSON.parse(body))).toEqual([{ drop_pending_updates: false }])
    expect(JSON.parse(stdout.output()).registrations[0]).toMatchObject({
      action: "delete",
      applied: true,
      result: { url: "" },
    })
  })

  it("discovers Telegram Channels with the selected stage environment", async () => {
    const rootDir = await mkdtemp(join(import.meta.dirname, "channel-sync-app-"))
    const stdout = stream()
    const requests: string[] = []
    const previousBotToken = process.env.TELEGRAM_BOT_TOKEN
    const previousWebhookToken = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
    process.env.TELEGRAM_BOT_TOKEN = "context-bot-token"
    delete process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
    try {
      await mkdir(join(rootDir, "config-env"), { recursive: true })
      await mkdir(join(rootDir, "server", "agents"), { recursive: true })
      await writeFile(join(rootDir, "vite.config.ts"), [
        'import { defineConfig } from "vite"',
        'export default defineConfig({ envDir: "config-env" })',
        "",
      ].join("\n"), "utf8")
      await writeFile(join(rootDir, "config-env", ".env.staging"), [
        "TELEGRAM_BOT_TOKEN=env-dir-bot-token",
        "TELEGRAM_WEBHOOK_SECRET_TOKEN=stage-webhook-token",
        "",
      ].join("\n"), "utf8")
      await writeFile(join(rootDir, "server", "agents", "support.ts"), [
        'import { defineAgent } from "@vite-hub/agent"',
        'import { telegram } from "@vite-hub/agent/channels"',
        "export default defineAgent({",
        "  channels: {",
        "    telegram: telegram({",
        "      botToken: process.env.TELEGRAM_BOT_TOKEN,",
        "      webhooks: {",
        "        secretHeader: 'x-telegram-bot-api-secret-token',",
        "        secretToken: { resolve: () => process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN },",
        "      },",
        "    }),",
        "  },",
        "  driver: { run: () => 'ok' },",
        "})",
        "",
      ].join("\n"), "utf8")
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        requests.push(url)
        if (init?.method === "HEAD") {
          return new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
        }
        return Response.json({ ok: true, result: { pending_update_count: 0, url: "" } })
      })

      const exitCode = await runAgentChannelSyncCli([
        "--stage", "staging",
        "--url", "https://staging.example.com",
        "--json",
      ], {
        cwd: rootDir,
        env: process.env,
        rootDir,
        stderr: stream(),
        stdout,
      }, { fetch: fetcher as never })

      expect(exitCode).toBe(0)
      expect(requests).toContain("https://api.telegram.org/botcontext-bot-token/getWebhookInfo")
      expect(stdout.output()).not.toContain("context-bot-token")
      expect(stdout.output()).not.toContain("env-dir-bot-token")
      expect(stdout.output()).not.toContain("stage-webhook-token")
      expect(JSON.parse(stdout.output()).registrations).toMatchObject([{
        agent: "support",
        channel: "telegram",
        desired: { secretToken: "configured" },
      }])

      await writeFile(join(rootDir, "server", "agents", "webhook-free.ts"), [
        'import { defineAgent } from "@vite-hub/agent"',
        'import { telegram } from "@vite-hub/agent/channels"',
        "export default defineAgent({",
        "  channels: {",
        "    telegram: telegram({ botToken: process.env.TELEGRAM_BOT_TOKEN, webhooks: [] }),",
        "  },",
        "  driver: { run: () => 'ok' },",
        "})",
        "",
      ].join("\n"), "utf8")
      await writeFile(join(rootDir, "server", "agents", "undeployed.ts"), [
        'import { defineAgent } from "@vite-hub/agent"',
        'import { discord } from "@vite-hub/agent/channels"',
        "export default defineAgent({",
        "  channels: { discord: discord() },",
        "  driver: { run: () => 'ok' },",
        "})",
        "",
      ].join("\n"), "utf8")

      const historyFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          expect(new Headers(init.headers).has("x-telegram-bot-api-secret-token")).toBe(false)
          return new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
        }
        expect(new Headers(init?.headers).get("x-telegram-bot-api-secret-token")).toBe("stage-webhook-token")
        return Response.json({ messages: [], schemaVersion: 1, threadId: "telegram:123" })
      })
      const historyStderr = stream()
      const historyExitCode = await runAgentChannelHistoryCli([
        "--stage", "staging",
        "--url", "https://staging.example.com",
        "--output", "history-export",
        "--thread", "telegram:123",
      ], {
        cwd: rootDir,
        env: process.env,
        rootDir,
        stderr: historyStderr,
        stdout: stream(),
      }, { fetch: historyFetch as never })
      expect(historyStderr.output()).toBe("")
      expect(historyExitCode).toBe(0)
      expect(historyFetch).toHaveBeenCalledTimes(2)
      expect(process.env.TELEGRAM_BOT_TOKEN).toBe("context-bot-token")
      expect(process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN).toBeUndefined()
    }
    finally {
      if (previousBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = previousBotToken
      if (previousWebhookToken === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
      else process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = previousWebhookToken
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("discovers Channels from the selected stage server directories", async () => {
    const rootDir = await mkdtemp(join(import.meta.dirname, "channel-sync-stage-dirs-"))
    const productionServerDir = join(rootDir, "production-server")
    try {
      await mkdir(join(productionServerDir, "agents"), { recursive: true })
      await writeFile(join(rootDir, "vite.config.ts"), [
        'import { defineConfig } from "vite"',
        'import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"',
        "export default defineConfig(({ mode }) => ({",
        `  [VITEHUB_SERVER_DIRS]: mode === "production" ? [${JSON.stringify(productionServerDir)}] : [],`,
        "}))",
        "",
      ].join("\n"), "utf8")
      await writeFile(join(productionServerDir, "agents", "support.ts"), [
        'import { defineAgent } from "@vite-hub/agent"',
        'import { telegram } from "@vite-hub/agent/channels"',
        'export default defineAgent({ channels: { telegram: telegram({ botToken: "bot-token" }) }, driver: { run: () => "ok" } })',
        "",
      ].join("\n"), "utf8")
      const requests: string[] = []
      const exitCode = await runAgentChannelSyncCli([
        "--stage", "production",
        "--url", "https://example.com",
      ], {
        cwd: rootDir,
        env: {},
        rootDir,
        stderr: stream(),
        stdout: stream(),
      }, {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(String(input))
          return init?.method === "HEAD"
            ? new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
            : Response.json({ ok: true, result: { pending_update_count: 0, url: "" } })
        }) as never,
      })

      expect(exitCode).toBe(0)
      expect(requests).toContain("https://api.telegram.org/botbot-token/getWebhookInfo")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("preserves the ambient environment when Vite server creation fails", async () => {
    const rootDir = await mkdtemp(join(import.meta.dirname, "channel-sync-invalid-app-"))
    const key = "VITEHUB_CHANNEL_SYNC_AMBIENT_TEST"
    const previous = process.env[key]
    process.env[key] = "preserved"
    try {
      await writeFile(join(rootDir, "vite.config.ts"), 'throw new Error("invalid stage config")\n', "utf8")
      const exitCode = await runAgentChannelSyncCli([
        "--stage", "production",
        "--url", "https://example.com",
      ], {
        cwd: rootDir,
        env: process.env,
        rootDir,
        stderr: stream(),
        stdout: stream(),
      })

      expect(exitCode).toBe(1)
      expect(process.env[key]).toBe("preserved")
    }
    finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("serializes concurrent stage environment loading", async () => {
    const firstRoot = await mkdtemp(join(import.meta.dirname, "channel-sync-concurrent-first-"))
    const secondRoot = await mkdtemp(join(import.meta.dirname, "channel-sync-concurrent-second-"))
    const key = "VITEHUB_CHANNEL_SYNC_CONCURRENT_TEST"
    const config = (expected: string, delay: number) => [
      "export default async function () {",
      `  await new Promise(resolve => setTimeout(resolve, ${delay}))`,
      `  if (process.env.${key} !== ${JSON.stringify(expected)}) throw new Error("wrong concurrent environment")`,
      `  throw new Error(${JSON.stringify(`expected ${expected} failure`)})`,
      "}",
      "",
    ].join("\n")
    try {
      await writeFile(join(firstRoot, "vite.config.ts"), config("first", 30), "utf8")
      await writeFile(join(secondRoot, "vite.config.ts"), config("second", 80), "utf8")
      const run = (rootDir: string, selected: string) => {
        const stderr = stream()
        return {
          result: runAgentChannelSyncCli([
            "--stage", "production",
            "--url", "https://example.com",
          ], {
            cwd: rootDir,
            env: { [key]: selected },
            rootDir,
            stderr,
            stdout: stream(),
          }),
          stderr,
        }
      }

      const first = run(firstRoot, "first")
      await new Promise(resolve => setTimeout(resolve, 5))
      const second = run(secondRoot, "second")
      expect(await Promise.all([first.result, second.result])).toEqual([1, 1])
      expect(first.stderr.output()).toContain("expected first failure")
      expect(second.stderr.output()).toContain("expected second failure")
      expect(first.stderr.output()).not.toContain("wrong concurrent environment")
      expect(second.stderr.output()).not.toContain("wrong concurrent environment")
    }
    finally {
      await rm(firstRoot, { force: true, recursive: true })
      await rm(secondRoot, { force: true, recursive: true })
    }
  })

  it("exposes the selected environment while Vite resolves its config", async () => {
    const rootDir = await mkdtemp(join(import.meta.dirname, "channel-sync-config-env-app-"))
    const key = "VITEHUB_CHANNEL_SYNC_CONFIG_ENV_DIR"
    const previous = process.env[key]
    process.env[key] = "wrong-env"
    try {
      await mkdir(join(rootDir, "selected-env"), { recursive: true })
      await mkdir(join(rootDir, "server", "agents"), { recursive: true })
      await writeFile(join(rootDir, "vite.config.ts"), [
        'import { defineConfig } from "vite"',
        `export default defineConfig({ envDir: process.env.${key} })`,
        "",
      ].join("\n"), "utf8")
      await writeFile(join(rootDir, "selected-env", ".env.production"), "TELEGRAM_BOT_TOKEN=selected-bot-token\n", "utf8")
      await writeFile(join(rootDir, "server", "agents", "support.ts"), [
        'import { defineAgent } from "@vite-hub/agent"',
        'import { telegram } from "@vite-hub/agent/channels"',
        "export default defineAgent({ channels: { telegram: telegram() }, driver: { run: () => 'ok' } })",
        "",
      ].join("\n"), "utf8")
      const requests: string[] = []
      const exitCode = await runAgentChannelSyncCli([
        "--stage", "production",
        "--url", "https://example.com",
      ], {
        cwd: rootDir,
        env: { [key]: "selected-env" },
        rootDir,
        stderr: stream(),
        stdout: stream(),
      }, {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(String(input))
          return init?.method === "HEAD"
            ? new Response(null, { headers: { "x-vitehub-channel-provider": "telegram" }, status: 204 })
            : Response.json({ ok: true, result: { pending_update_count: 0, url: "" } })
        }) as never,
      })

      expect(exitCode).toBe(0)
      expect(requests).toContain("https://api.telegram.org/botselected-bot-token/getWebhookInfo")
      expect(process.env[key]).toBe("wrong-env")
    }
    finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("prints Agent information when the Vite server root is nested under the project root", async () => {
    const stdout = stream()
    const fetchAgentInfo = vi.fn(async () => Response.json({
      inspection: {
        config: {
          driver: {
            capacity: { active: 1, concurrency: 2, pending: 3, queue: { maxPending: 20, timeout: 300_000 } },
            executionAuthority: {
              credentials: "ambient",
              environment: "ambient",
              filesystem: { access: "read-write", scope: "host" },
              isolation: "none",
              network: "unrestricted",
              processes: "arbitrary",
            },
            kind: "model",
            model: { id: "openai/gpt-5" },
          },
        },
        files: [
          {
            children: [{ kind: "file", path: "docs/AGENTS.md", source: "docs" }],
            kind: "directory",
            path: "docs",
            source: "docs",
          },
        ],
        instructions: ["docs/AGENTS.md"],
        invokerProfiles: [{ id: "technical" }],
        name: "support",
        tools: [{ name: "search" }, { name: "shell" }],
        warnings: [],
      },
      root: "/repo/app",
    }))

    const exitCode = await runAgentInfoCli([], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, { fetch: fetchAgentInfo as never })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toBe([
      "Agent: support",
      "Metadata: ready",
      "Driver: Model-backed Agent Driver (openai/gpt-5)",
      "Capacity: 1/2 active, 3/20 pending, 300000ms timeout",
      "Execution authority:",
      "  Filesystem: host, read-write",
      "  Network: unrestricted",
      "  Environment: ambient",
      "  Credentials: ambient",
      "  Process execution: arbitrary",
      "  Isolation: none",
      "Capabilities: 0 Capabilities (none)",
      "Tools: 2 tools (search, shell)",
      "Workspace files: 1 file, 1 directory, 1 source",
      "Instructions: 1 document",
      "Invoker profiles: 1 profile",
      "Warnings: 0 warnings",
      "",
    ].join("\n"))
    expect(fetchAgentInfo).toHaveBeenCalledWith("http://localhost:5173/__vitehub/agent/invocation-stream?inspect=1", expect.objectContaining({
      headers: expect.objectContaining({
        [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      }),
    }))
  })

  it("prints execution authority in the existing Agent inspection contract as JSON", async () => {
    const stdout = stream()
    const fetchAgentInfo = vi.fn(async () => Response.json({
      inspection: {
        capabilities: [{ id: "runtime", metadata: { status: "ready" } }],
        config: { driver: { executionAuthority: unknownExecutionAuthorityFixture, kind: "unknown" } },
        files: [],
        instructions: [],
        invokerProfiles: [],
        name: "support",
        tools: [{ name: "shell" }],
        version: "1",
        warnings: [],
      },
    }))

    const exitCode = await runAgentInfoCli(["--agent", "support", "--json"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, { fetch: fetchAgentInfo as never })

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.output())).toEqual({
      capabilities: [{ id: "runtime", metadata: { status: "ready" } }],
      config: { driver: { executionAuthority: unknownExecutionAuthorityFixture, kind: "unknown" } },
      files: [],
      instructions: [],
      invokerProfiles: [],
      name: "support",
      tools: [{ name: "shell" }],
      version: "1",
      warnings: [],
    })
    expect(fetchAgentInfo).toHaveBeenCalledWith("http://localhost:5173/__vitehub/agent/invocation-stream?inspect=1&agent=support", expect.anything())
  })

  it("lists durable Agent Invocations as JSON", async () => {
    const stdout = stream()
    const fetchInvocations = vi.fn(async () => Response.json({
      invocations: [{
        createdAt: "2026-08-22T10:00:00.000Z",
        cursor: "1",
        id: "invocation-1",
        status: "failed",
        traceId: "trace-1",
        updatedAt: "2026-08-22T10:01:00.000Z",
      }],
    }))

    const exitCode = await runAgentInvocationsCli([
      "list", "--status", "failed", "--limit", "10", "--json",
    ], {
      env: {},
      stderr: stream(),
      stdout,
    }, { fetch: fetchInvocations as never })

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.output())).toMatchObject({ invocations: [{ id: "invocation-1", status: "failed" }] })
    expect(fetchInvocations).toHaveBeenCalledWith(
      "http://localhost:5173/api/invocations?status=failed&limit=10",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    )
  })

  it("shows a wrapped invocation detail record", async () => {
    const stdout = stream()
    const timestamp = "2026-08-22T10:00:00.000Z"
    const fetchInvocations = vi.fn(async () => Response.json({
      invocation: {
        createdAt: timestamp,
        cursor: "1",
        id: "invocation-1",
        status: "completed",
        traceId: "trace-1",
        updatedAt: timestamp,
      },
      observations: [{ name: "agent.completed", sequence: 1, timestamp, type: "lifecycle" }],
    }))

    const exitCode = await runAgentInvocationsCli(["show", "invocation-1"], {
      env: {},
      stderr: stream(),
      stdout,
    }, { fetch: fetchInvocations as never })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toContain("invocation-1 completed")
    expect(stdout.output()).toContain("1 2026-08-22T10:00:00.000Z agent.completed")
  })

  it("tails new observations and prints a nested terminal failure", async () => {
    const stdout = stream()
    const stderr = stream()
    const base = {
      createdAt: "2026-08-22T10:00:00.000Z",
      cursor: "1",
      id: "invocation-1",
      traceId: "trace-1",
      updatedAt: "2026-08-22T10:01:00.000Z",
    }
    const fetchInvocations = vi.fn()
      .mockResolvedValueOnce(Response.json({
        invocation: { ...base, status: "running" },
        observations: [{ name: "agent.started", sequence: 1, timestamp: base.createdAt, type: "lifecycle" }],
      }))
      .mockResolvedValueOnce(Response.json({
        invocation: {
          ...base,
          error: {
            errors: [{ message: "Checkout failed", name: "Error" }, { message: "Restore failed", name: "Error" }],
            message: "Workspace failed",
            name: "AggregateError",
          },
          status: "failed",
        },
        observations: [
          { name: "agent.started", sequence: 1, timestamp: base.createdAt, type: "lifecycle" },
          { name: "agent.failed", sequence: 2, timestamp: base.updatedAt, type: "error" },
        ],
      }))

    const exitCode = await runAgentInvocationsCli(["tail", "invocation-1", "--json"], {
      env: {},
      stderr,
      stdout,
    }, { fetch: fetchInvocations as never, sleep: async () => {} })

    expect(exitCode).toBe(1)
    expect(stdout.output().trim().split("\n").map(line => JSON.parse(line).sequence)).toEqual([1, 2])
    expect(stderr.output()).toBe("AggregateError: Workspace failed\n")
  })

  it("prints unknown execution authority without inferring restrictions", async () => {
    const stdout = stream()
    const exitCode = await runAgentInfoCli([], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, {
      fetch: vi.fn(async () => Response.json({
        inspection: {
          config: { driver: { executionAuthority: unknownExecutionAuthorityFixture, kind: "unknown" } },
          name: "opaque",
        },
      })) as never,
    })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toContain([
      "Execution authority:",
      "  Filesystem: unknown",
      "  Network: unknown",
      "  Environment: unknown",
      "  Credentials: unknown",
      "  Process execution: unknown",
      "  Isolation: unknown",
    ].join("\n"))
  })

  it("reports unavailable execution authority without treating it as none", async () => {
    const stdout = stream()
    const exitCode = await runAgentInfoCli([], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, {
      fetch: vi.fn(async () => Response.json({ inspection: { name: "legacy" } })) as never,
    })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toContain("Execution authority: unavailable\n")
    expect(stdout.output()).not.toContain("Execution authority: none")
  })

  it.each([
    { config: {}, label: "missing Driver metadata" },
    { config: { driver: { executionAuthority: {}, kind: "unknown" } }, label: "malformed execution authority" },
  ])("reports $label as unavailable", async ({ config }) => {
    const stdout = stream()
    const exitCode = await runAgentInfoCli([], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr: stream(),
      stdout,
    }, {
      fetch: vi.fn(async () => Response.json({
        inspection: {
          config,
          name: "legacy",
        },
      })) as never,
    })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toContain("Execution authority: unavailable\n")
  })

  it("requires an Agent target when multiple Agents are discovered", async () => {
    const stderr = stream()
    const fetchAgentInfo = vi.fn(async () => new Response("Multiple Agents discovered. Pass --agent review|support.", { status: 400 }))

    const exitCode = await runAgentInfoCli([], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, { fetch: fetchAgentInfo as never })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toBe("Multiple Agents discovered. Pass --agent review|support.\n")
  })

  it("reports an invalid Agent inspection response", async () => {
    const stderr = stream()
    const exitCode = await runAgentInfoCli([], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, { fetch: vi.fn(async () => new Response("not json")) as never })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toBe("Agent inspection returned an invalid response from http://localhost:5173.\n")
  })

  it("bounds Agent inspection requests", async () => {
    const stderr = stream()
    const fetchAgentInfo = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
      return Response.json({})
    })

    const exitCode = await runAgentInfoCli([], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, { fetch: fetchAgentInfo as never, timeout: 1 })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toBe("Agent inspection request timed out after 1ms.\n")
  })

  it("rejects an Agent inspection server for a different project root", async () => {
    const stderr = stream()
    const exitCode = await runAgentInfoCli([], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      stderr,
      stdout: stream(),
    }, { fetch: vi.fn(async () => Response.json({ inspection: { name: "support" }, root: "/other-repo" })) as never })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toBe("Compatible Vite Development Server root mismatch: /other-repo\n")
  })

  it("streams an Agent Dev Loop message when the Vite server root is nested under the project root", async () => {
    const stdout = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", metadata: {}, trigger: "chat.message", type: "start" },
          { text: "hello from agent", type: "text-delta" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "support", triggers: ["chat.message"] }],
        root: "/repo/app",
      })
    })

    const exitCode = await runAgentDevCli(["-p", "hello agent"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout,
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toBe("hello from agent\n")
    expect(fetchAgentStream).toHaveBeenCalledTimes(2)
    const [get, post] = fetchAgentStream.mock.calls
    expect(get?.[1]?.headers).toMatchObject({
      accept: "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    expect(post?.[1]?.headers).toMatchObject({
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    expect(post?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      agent: "support",
      messages: [{
        parts: [{ text: "hello agent", type: "text" }],
        role: "user",
      }],
    })
  })

  it("keeps --prompt input literal when it starts with !", async () => {
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "chat", metadata: {}, trigger: "chat.message", type: "start" },
          { text: "portal commands", type: "text-delta" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "chat", triggers: ["chat.message"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["--agent", "chat", "--prompt", "!portal-api help"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout: stream(),
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    const post = fetchAgentStream.mock.calls.find(([, init]) => init?.method === "POST")
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      agent: "chat",
      messages: [{
        parts: [{ text: "!portal-api help", type: "text" }],
        role: "user",
      }],
    })
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty("workspaceCommand")
  })

  it("accepts Agent Dev Loop discovery aliases", async () => {
    const stdout = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "review", type: "start" },
          { text: "summary", type: "text-delta" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ aliases: ["summary"], name: "review", triggers: ["github.webhook"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["--agent", "summary", "-p", "/summary"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout,
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toBe("summary\n")
    const post = fetchAgentStream.mock.calls[1]
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      agent: "summary",
    })
  })

  it("runs a Capability CLI command through the Agent Dev Loop endpoint", async () => {
    const stdout = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({
          argv: ["items", "list", "--json"],
          capability: "inventory-runtime",
          cli: "inventory",
          command: "inventory items list --json",
          durationMs: 1,
          exitCode: 0,
          json: [{ id: "item_1" }],
          outputTruncated: false,
          stderr: "",
          stdout: "[{\"id\":\"item_1\"}]\n",
        })
      }
      return Response.json({
        agents: [{ name: "chat", triggers: ["chat.message"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["--agent", "chat", "--cli", "inventory", "--", "items", "list", "--json"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout,
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toBe("[{\"id\":\"item_1\"}]\n")
    const post = fetchAgentStream.mock.calls[1]
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      agent: "chat",
      cli: {
        argv: ["items", "list", "--json"],
        name: "inventory",
      },
    })
  })

  it("runs ! commands with the nested Vite server root's Workspace token", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-cli-"))
    const serverRoot = join(rootDir, "app")
    const stdout = stream()
    const stderr = stream()
    const tokenServerId = "pid-1:5173"
    const token = await refreshWorkspaceDevToken(serverRoot, { serverId: tokenServerId })
    try {
      const payloadPath = join(rootDir, "payload.json")
      await writeFile(payloadPath, JSON.stringify({ tenant: "api" }), "utf8")
      const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Response.json({
            args: ["test", "--filter", "api"],
            command: "pnpm",
            exitCode: 0,
            stderr: "",
            stdout: "ok\n",
          })
        }
        return Response.json({
          agents: [{ name: "chat", triggers: ["chat.message"] }],
          root: serverRoot,
          workspaceDevTokenServerId: tokenServerId,
        })
      })

      const exitCode = await runAgentDevCli(["--agent", "chat", "--payload", "payload.json", "!pnpm", "test", "--filter", "api"], {
        cwd: rootDir,
        env: {},
        rootDir,
        spawn: vi.fn(),
        stderr,
        stdout,
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(0)
      expect(stdout.output()).toBe("ok\n")
      expect(stderr.output()).toContain(`Loaded payload: ${payloadPath}\n[workspace] command started; first run may materialize sources.\n`)
      expect(stderr.output()).toContain("[workspace] command completed")
      const post = fetchAgentStream.mock.calls[1]
      expect(post?.[1]?.headers).toMatchObject({
        [workspaceDevTokenHeader]: token,
      })
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        agent: "chat",
        payload: { tenant: "api" },
        workspaceCommand: {
          args: ["test", "--filter", "api"],
          command: "pnpm",
        },
      })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("runs positional Agent Dev Loop ! commands through the selected Agent Workspace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-cli-"))
    const stdout = stream()
    const tokenServerId = "pid-1:5173"
    const token = await refreshWorkspaceDevToken(rootDir, { serverId: tokenServerId })
    try {
      const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Response.json({
            args: ["ok", "--flag"],
            command: "printf",
            exitCode: 0,
            stderr: "",
            stdout: "ok\n",
          })
        }
        return Response.json({
          agents: [{ name: "proof-agent", triggers: [] }],
          root: rootDir,
          workspaceDevTokenServerId: tokenServerId,
        })
      })

      const exitCode = await runAgentDevCli(["--url", "http://127.0.0.1:5173", "--timeout", "10000", "proof-agent", "!printf", "ok", "--flag"], {
        cwd: rootDir,
        env: {},
        rootDir,
        spawn: vi.fn(),
        stderr: stream(),
        stdout,
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(0)
      expect(stdout.output()).toBe("ok\n")
      const [get, post] = fetchAgentStream.mock.calls
      expect(String(get?.[0])).toBe("http://127.0.0.1:5173/__vitehub/agent/invocation-stream")
      expect(post?.[1]?.headers).toMatchObject({
        [workspaceDevTokenHeader]: token,
      })
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        agent: "proof-agent",
        timeout: 10000,
        workspaceCommand: {
          args: ["ok", "--flag"],
          command: "printf",
          timeout: 10000,
        },
      })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("keeps payload diagnostics off stdout for Capability CLI commands", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-cli-payload-"))
    try {
      const payloadPath = join(rootDir, "payload.json")
      await writeFile(payloadPath, JSON.stringify({ tenant: "inventory" }), "utf8")
      const stderr = stream()
      const stdout = stream()
      const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Response.json({
            argv: ["list", "--json"],
            capability: "inventory-runtime",
            cli: "inventory",
            command: "inventory list --json",
            durationMs: 1,
            exitCode: 0,
            outputTruncated: false,
            stderr: "",
            stdout: "[]\n",
          })
        }
        return Response.json({
          agents: [{ name: "chat", triggers: ["chat.message"] }],
          root: rootDir,
        })
      })

      const exitCode = await runAgentDevCli(["--agent", "chat", "--payload", "payload.json", "--cli", "inventory", "--", "list", "--json"], {
        cwd: rootDir,
        env: {},
        rootDir,
        spawn: vi.fn(),
        stderr,
        stdout,
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(0)
      expect(stdout.output()).toBe("[]\n")
      expect(stderr.output()).toBe(`Loaded payload: ${payloadPath}\n`)
      const post = fetchAgentStream.mock.calls.find(([, init]) => init?.method === "POST")
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
        agent: "chat",
        cli: {
          argv: ["list", "--json"],
          name: "inventory",
        },
        payload: { tenant: "inventory" },
      })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("renders and clears the default Agent Dev Loop thinking fallback", async () => {
    const stderr = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", trigger: "chat.message", type: "start" },
          { text: "done", type: "text-delta" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "support", triggers: ["chat.message"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["hello"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout: stream(),
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stderr.output()).toBe("\u001B[?25l\rThinking...\r\u001b[K\u001B[?25h")
  })

  it("uses Agent Dev Loop thinking fallback metadata", async () => {
    const stderr = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", metadata: { thinkingFallback: "Reading PR..." }, trigger: "chat.message", type: "start" },
          { id: "tool-1", input: { command: "ls" }, name: "workspaceShell", type: "tool-call" },
          { text: "done", type: "text-delta" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "support", triggers: ["chat.message"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["hello"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout: stream(),
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stderr.output()).toContain("\u001B[?25l\rReading PR...\r\u001b[K\u001B[?25h")
    expect(stderr.output()).toContain("[tool] ls")
    expect(stderr.output()).not.toContain("Thinking...")
  })

  it("respects disabled Agent Dev Loop thinking fallback metadata", async () => {
    const stderr = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", metadata: { thinkingFallback: null }, trigger: "chat.message", type: "start" },
          { text: "done", type: "text-delta" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "support", triggers: ["chat.message"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["hello"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout: stream(),
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stderr.output()).toBe("")
  })

  it("loads an Agent Trigger payload from a JSON file", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-payload-"))
    const rootDir = join(workspaceDir, "app")
    await mkdir(rootDir)
    try {
      const payloadPath = join(rootDir, "payload.json")
      await writeFile(payloadPath, JSON.stringify({
        meta: {
          audience: "technical",
        },
        user: {
          email: "dev@example.com",
          id: "dev_1",
        },
      }), "utf8")
      const stdout = stream()
      const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return ndjson([
            { agent: "review", trigger: "github.webhook", type: "start" },
            { text: "summary", type: "text-delta" },
            { type: "finish" },
            { type: "done" },
          ])
        }
        return Response.json({
          agents: [{ name: "review", triggers: ["chat.message"] }],
          root: rootDir,
        })
      })

      const exitCode = await runAgentDevCli(["--agent", "review", "--payload", "payload.json", "--prompt=/summary"], {
        cwd: workspaceDir,
        env: {},
        rootDir,
        spawn: vi.fn(),
        stderr: stream(),
        stdout,
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(0)
      expect(stdout.output()).toBe(`Loaded payload: ${payloadPath}\nsummary\n`)
      const post = fetchAgentStream.mock.calls.find(([, init]) => init?.method === "POST")
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
        agent: "review",
        messages: [{
          parts: [{ text: "/summary", type: "text" }],
          role: "user",
        }],
        payload: {
          meta: {
            audience: "technical",
          },
          user: {
            email: "dev@example.com",
            id: "dev_1",
          },
        },
      })
    }
    finally {
      await rm(workspaceDir, { force: true, recursive: true })
    }
  })

  it("keeps payload-only chat runs interactive unless messages are in the payload", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-payload-interactive-"))
    const stdin = process.stdin as { isTTY?: boolean }
    const originalIsTTY = process.stdin.isTTY
    stdin.isTTY = false
    try {
      const payloadPath = join(rootDir, "payload.json")
      await writeFile(payloadPath, JSON.stringify({
        meta: { audience: "technical" },
        user: { id: "dev_1" },
      }), "utf8")
      const stderr = stream()
      const stdout = stream()
      const fetchAgentStream = vi.fn(async () => Response.json({
        agents: [{ name: "support", triggers: ["chat.message"] }],
        root: rootDir,
      }))

      const exitCode = await runAgentDevCli(["--agent", "support", "--payload", "payload.json"], {
        cwd: rootDir,
        env: {},
        rootDir,
        spawn: vi.fn(),
        stderr,
        stdout,
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(1)
      expect(stdout.output()).toBe(`Loaded payload: ${payloadPath}\n`)
      expect(stderr.output()).toBe("Pass a message or run in an interactive terminal.\n")
      expect(fetchAgentStream).toHaveBeenCalledTimes(1)
    }
    finally {
      stdin.isTTY = originalIsTTY
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("rejects non-object Agent Dev Loop payload files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-payload-"))
    try {
      await writeFile(join(rootDir, "payload.json"), "[1,2,3]", "utf8")
      const stderr = stream()
      const fetchAgentStream = vi.fn()
      const exitCode = await runAgentDevCli(["--payload", "payload.json", "hello"], {
        cwd: rootDir,
        env: {},
        rootDir,
        spawn: vi.fn(),
        stderr,
        stdout: stream(),
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(1)
      expect(fetchAgentStream).not.toHaveBeenCalled()
      expect(stderr.output()).toContain("Agent Dev Loop payload file must contain a JSON object.")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("surfaces Agent Dev Loop approval requests", async () => {
    const stderr = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", trigger: "chat.message", type: "start" },
          { id: "approval-1", name: "workspace_write", reason: "Needs write access.", type: "approval-request" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "support", triggers: ["chat.message"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["hello"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout: stream(),
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("[approval required] workspace_write: Needs write access.")
  })

  it("renders Agent Dev Loop tool output and final usage note", async () => {
    const stderr = stream()
    const stdout = stream()
    const longOutput = "x".repeat(1300)
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", trigger: "chat.message", type: "start" },
          { id: "tool-1", name: "shell", type: "tool-input-start" },
          { id: "tool-1", input: { command: "cat file.md" }, name: "shell", type: "tool-call" },
          { durationMs: 1200, id: "tool-1", name: "shell", output: { command: "cat file.md", exitCode: 0, stderr: "", stdout: longOutput }, type: "tool-result" },
          { id: "tool-4", input: { cmd: "pnpm test" }, name: "bash", type: "tool-call" },
          { id: "tool-5", input: {}, name: "mcp_nuxt_get_documentation_page", type: "tool-input-start" },
          { id: "tool-5", input: { path: "/docs/4.x/api/composables/use-lazy-fetch" }, name: "mcp_nuxt_get_documentation_page", type: "tool-call" },
          { id: "tool-5", name: "mcp_nuxt_get_documentation_page", output: { content: "useLazyFetch docs" }, type: "tool-result" },
          { id: "tool-8", input: { command: "sleep 10" }, name: "shell", type: "tool-input-start" },
          { id: "tool-6", input: { query: "Agent Dev Loop" }, name: "search_docs", type: "tool-input-start" },
          { durationMs: 42, id: "tool-6", name: "search_docs", output: { text: "search result" }, type: "tool-result" },
          { id: "tool-7", input: {}, name: "lookup_doc", type: "tool-call" },
          { id: "tool-7", input: { slug: "final" }, name: "lookup_doc", type: "tool-call" },
          { durationMs: 7, id: "tool-7", name: "lookup_doc", output: { text: "lookup result" }, type: "tool-result" },
          { id: "tool-12", input: { argv: ["purchase-orders"] }, name: "portal", type: "tool-call" },
          { id: "tool-12", input: { argv: ["purchase-orders"], input: { limit: 100, planningGroupId: "demo" }, json: true }, name: "portal", type: "tool-call" },
          { id: "tool-15", input: { argv: ["post"], input: "abc" }, name: "portal", type: "tool-call" },
          { id: "tool-14", input: { argv: ["post"], input: "line one\nline two" }, name: "portal", type: "tool-call" },
          { id: "tool-13", input: { operation: "comment", body: "line one\nline two", target: { id: "PR-1" } }, name: "repository_host_write", type: "tool-call" },
          { id: "tool-9", input: { query: "first" }, name: "first_tool", type: "tool-call" },
          { id: "tool-10", input: { query: "second" }, name: "second_tool", type: "tool-call" },
          { id: "tool-10", name: "second_tool", output: { text: "second done" }, type: "tool-result" },
          { id: "tool-9", name: "first_tool", output: { text: "first done" }, type: "tool-result" },
          { id: "tool-11", input: { query: "still running" }, name: "unfinished_tool", type: "tool-call" },
          { id: "tool-2", name: "workspace_list", output: { path: "." }, type: "tool-result" },
          { id: "tool-3", name: "run_summary", output: { raw: { raw: { steps: longOutput } }, text: "summary body" }, type: "tool-result" },
          { text: "done", type: "text-delta" },
          { type: "usage", usageRecord: { cost: { amount: "0.01", currency: "USD" }, usage: { totalTokens: 17 } } },
          { type: "usage", usageRecord: { cost: { usd: "0.00000400", display: "~$0.000004", estimated: true, source: "estimated" }, latency: { durationMs: 2000, tokensPerSecond: 3.5 }, usage: { inputTokens: 10, outputTokenDetails: { reasoningTokens: 3 }, outputTokens: 7, totalTokens: 17 } } },
          { type: "usage", usageRecord: { cost: { usd: "0.00000400", display: "~$0.000004", estimated: true, source: "estimated" }, latency: { durationMs: 2000, tokensPerSecond: 3.5 }, usage: { inputTokens: 10, outputTokenDetails: { reasoningTokens: 3 }, outputTokens: 7, totalTokens: 17 } } },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "support", triggers: ["chat.message"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["hello"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout,
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stderr.output()).toContain("[tool] cat file.md")
    expect(stderr.output()).toContain("duration: 1.2s")
    expect(stderr.output()).toContain("[tool] pnpm test")
    expect(stderr.output()).not.toContain("[tool] bash")
    expect(stderr.output()).not.toContain("[tool done]")
    expect(stderr.output()).not.toContain(`input: {"command":"cat file.md"}`)
    expect(stderr.output()).toContain(`\n[tool] mcp_nuxt_get_documentation_page\n  input: {"path":"/docs/4.x/api/composables/use-lazy-fetch"}\n`)
    expect(stderr.output()).toContain(`output: {"content":"useLazyFetch docs"}`)
    expect(stderr.output()).toContain(`\n[tool] sleep 10\n`)
    expect(stderr.output()).toContain(`\n[tool] search_docs {"query":"Agent Dev Loop"}\nsearch result\n  duration: 42ms\n---\n`)
    expect(stderr.output()).toContain(`\n[tool] lookup_doc\n  input: {"slug":"final"}\nlookup result\n  duration: 7ms\n---\n`)
    expect(stderr.output()).not.toContain(`\n[tool] lookup_doc {}\n`)
    expect(stderr.output()).toContain(`\n[tool] portal purchase-orders\n`)
    expect(stderr.output()).toContain(`\n[tool] portal purchase-orders --json --input '{"limit":100,"planningGroupId":"demo"}'\n`)
    expect(stderr.output()).toContain(`\n[tool] portal post --input '"abc"'\n`)
    expect(stderr.output()).not.toContain(`[tool] portal {"argv":["purchase-orders"]`)
    expect(stderr.output()).toContain(`\n[tool] portal post --input '"line one\\nline two"'\n`)
    expect(stderr.output()).toContain(`\n[tool] repository_host_write {"operation":"comment","body":"line one\\nline two","target":{"id":"PR-1"}}\n`)
    const firstToolIndex = stderr.output().indexOf(`[tool] first_tool {"query":"first"}`)
    const secondToolIndex = stderr.output().indexOf(`[tool] second_tool {"query":"second"}`)
    expect(firstToolIndex).toBeGreaterThanOrEqual(0)
    expect(secondToolIndex).toBeGreaterThan(firstToolIndex)
    expect(stderr.output()).toContain(`\n[tool] unfinished_tool {"query":"still running"}\n`)
    expect(stderr.output()).toContain("[truncated ")
    expect(stderr.output()).not.toContain(longOutput)
    expect(stderr.output()).toContain("---")
    expect(stderr.output()).toContain("[tool] workspace_list")
    expect(stderr.output()).toContain(`output: {"path":"."}`)
    expect(stderr.output()).toContain("[tool] run_summary")
    expect(stderr.output()).toContain("summary body")
    expect(stderr.output()).not.toContain(`output: {"raw"`)
    expect(stderr.output()).not.toContain("[usage]")
    expect(stderr.output().match(/\[tool\] cat file\.md/g)).toHaveLength(1)
    expect(stdout.output()).toContain("done\n\n> [!NOTE]\n> Usage: cost ~$0.000004; 17 tokens: 10 in / 7 out; 3 reasoning tokens; time 2.0s; speed 3.5 tok/s")
  })

  it("adds best-effort pricing to Agent Dev Loop usage notes", async () => {
    const stderr = stream()
    const stdout = stream()
    const pricingFetch = vi.fn(async () => Response.json({
      data: [{
        id: "anthropic/claude-opus-4.8",
        pricing: {
          input: "0.000005",
          output: "0.000025",
        },
      }],
    }))
    vi.stubGlobal("fetch", pricingFetch)
    try {
      const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return ndjson([
            { agent: "support", trigger: "chat.message", type: "start" },
            { text: "done", type: "text-delta" },
            { type: "usage", usageRecord: { latency: { durationMs: 1000 }, model: "claude-opus-4-8", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
            { type: "finish" },
          ])
        }
        return Response.json({
          agents: [{ name: "support", triggers: ["chat.message"] }],
          root: "/repo",
        })
      })

      const exitCode = await runAgentDevCli(["hello"], {
        cwd: "/repo",
        env: {},
        rootDir: "/repo",
        spawn: vi.fn(),
        stderr,
        stdout,
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(0)
      expect(stdout.output()).toContain("> Usage: cost ~$0.000175; 15 tokens: 10 in / 5 out; time 1.0s; speed 5.0 tok/s")
      expect(pricingFetch).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it("renders Agent Dev Loop delivery previews", async () => {
    const stderr = stream()
    const stdout = stream()
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-delivery-payload-"))
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "review", trigger: "github.webhook", type: "start" },
          { channelId: "github", effect: { kind: "reaction", payload: { content: "eyes" } }, type: "delivery-preview" },
          { channelId: "discord", effect: { kind: "title", payload: { targetId: "thread-1", title: "Review agent summary" } }, type: "delivery-preview" },
          { channelId: "slack", effect: { kind: "title", payload: { title: "Title only" } }, type: "delivery-preview" },
          { channelId: "custom", effect: { kind: "title", payload: { value: "Inspect title payload" } }, type: "delivery-preview" },
          { text: "verbose review prose", type: "text-delta" },
          { channelId: "github", effect: { artifacts: [{ path: "screenshots/login.png", url: "https://assets.example/login.png" }], kind: "reply", payload: { body: "**Summary:** Short review.\n\n<details>\n<summary>Usage telemetry</summary>\n\nlarge table\n</details>" } }, type: "delivery-preview" },
          { channelId: "github", effect: { kind: "reaction", payload: { action: "remove", content: "eyes" } }, type: "delivery-preview" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "review", triggers: ["github.webhook"] }],
        root: rootDir,
      })
    })

    try {
      const payloadPath = join(rootDir, "payload.json")
      await writeFile(payloadPath, "{}", "utf8")
      const exitCode = await runAgentDevCli(["--agent", "review", "--trigger", "github.webhook", "--payload", "payload.json"], {
        cwd: rootDir,
        env: {},
        rootDir,
        spawn: vi.fn(),
        stderr,
        stdout,
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(0)
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }

    expect(stdout.output()).toBe(`Loaded payload: ${join(rootDir, "payload.json")}\nverbose review prose\n`)
    expect(stderr.output()).toContain("[delivery] reaction eyes on github")
    expect(stderr.output()).toContain("[delivery] title Review agent summary on discord")
    expect(stderr.output()).toContain('payload: {"targetId":"thread-1","title":"Review agent summary"}')
    expect(stderr.output()).toContain("[delivery] title Title only on slack")
    expect(stderr.output()).not.toContain('payload: {"title":"Title only"}')
    expect(stderr.output()).toContain("[delivery] title on custom")
    expect(stderr.output()).toContain('payload: {"value":"Inspect title payload"}')
    expect(stderr.output()).toContain("[delivery] asset screenshots/login.png on github")
    expect(stderr.output()).toContain("url: https://assets.example/login.png")
    expect(stderr.output()).toContain("[delivery preview] would reply on github")
    expect(stderr.output()).toContain("[delivery] remove reaction eyes on github")
    expect(stderr.output()).not.toContain("[tool] reaction")
    expect(stderr.output()).not.toContain("[tool] title")
    expect(stderr.output()).not.toContain("[tool] reply")
    expect(stderr.output()).not.toContain("[delivery preview] would title")
    expect(stderr.output()).toContain("body: **Summary:** Short review.")
    expect(stderr.output()).toContain("Usage telemetry")
    expect(stderr.output()).toContain("large table")
    expect(stderr.output().match(/\[delivery\] reaction eyes on github/g)).toHaveLength(1)
    expect(stderr.output().indexOf("[delivery] reaction eyes on github")).toBeLessThan(stderr.output().indexOf("[delivery] asset screenshots/login.png on github"))
    expect(stderr.output().indexOf("[delivery] asset screenshots/login.png on github")).toBeLessThan(stderr.output().indexOf("body: **Summary:** Short review."))
    expect(stderr.output().indexOf("body: **Summary:** Short review.")).toBeLessThan(stderr.output().indexOf("[delivery] remove reaction eyes on github"))
    expect(stderr.output()).not.toContain("verbose review prose")
  })

  it("formats structured Agent Dev Loop stream errors", async () => {
    async function runWithPost(response: Response) {
      const stderr = stream()
      const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return response
        return Response.json({
          agents: [{ name: "review", triggers: ["github.webhook"] }],
          root: "/repo",
        })
      })

      const exitCode = await runAgentDevCli(["--agent", "review", "--trigger", "github.webhook", "-p", "/review"], {
        cwd: "/repo",
        env: {},
        rootDir: "/repo",
        spawn: vi.fn(),
        stderr,
        stdout: stream(),
      }, { fetch: fetchAgentStream as never })

      return { exitCode, stderr: stderr.output() }
    }

    const emitted = await runWithPost(ndjson([
      { agent: "review", trigger: "github.webhook", type: "start" },
      { error: { code: "reaction_preview_failed", message: "GitHub reaction preview failed", status: 422 }, type: "error" },
      { type: "done" },
    ]))
    expect(emitted.exitCode).toBe(1)
    expect(emitted.stderr).toContain(`{"code":"reaction_preview_failed","message":"GitHub reaction preview failed","status":422}`)
    expect(emitted.stderr).not.toContain("[object Object]")

    const thrown = await runWithPost(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error({ code: "stream_read_failed", message: "reader failed" })
      },
    }), {
      headers: { "content-type": "application/x-ndjson" },
    }))
    expect(thrown.exitCode).toBe(1)
    expect(thrown.stderr).toContain(`{"code":"stream_read_failed","message":"reader failed"}`)
    expect(thrown.stderr).not.toContain("[object Object]")
  })

  it("runs Evalite through the Node runner with ViteHub defaults", async () => {
    const runner = vi.fn(async () => ({ exitCode: undefined }))
    const exitCode = await runAgentEvalCli(["server/agents/support.eval.ts"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout: stream(),
    }, undefined, runner, vi.fn(async () => "/repo/.vitehub/agent/evalite.config.ts"), [
      "/external/server/**/*.eval.?(m)ts",
      "/external/server/**/eval.?(m)ts",
    ])

    expect(exitCode).toBe(0)
    expect(runner).toHaveBeenCalledWith({
      cache: undefined,
      cacheEnabled: undefined,
      cwd: "/repo",
      include: [
        "/external/server/**/*.eval.?(m)ts",
        "/external/server/**/eval.?(m)ts",
      ],
      forceRerunTriggers: [
        "server/agents/**",
        "src/**/*.agent.*",
        "src/**/*.eval.*",
      ],
      hideTable: undefined,
      maxConcurrency: undefined,
      mode: "run-once-and-exit",
      outputPath: undefined,
      path: "server/agents/support.eval.ts",
      scoreThreshold: undefined,
      server: undefined,
      setupFiles: undefined,
      testTimeout: undefined,
      trialCount: undefined,
    })
  })

  it("passes supported Evalite runner options exactly", async () => {
    const runner = vi.fn(async () => ({ exitCode: undefined }))
    const exitCode = await runAgentEvalCli([
      "watch",
      "server/agents/support.eval.ts",
      "--threshold",
      "85",
      "--output",
      "eval-results.json",
      "--hide-table",
      "--no-cache",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout: stream(),
    }, {
      forceRerunTriggers: ["server/agents/support/**"],
      maxConcurrency: 1,
      testTimeout: 300000,
    }, runner, vi.fn(async () => "/repo/.vitehub/agent/evalite.config.ts"))

    expect(exitCode).toBe(0)
    expect(runner).toHaveBeenCalledWith({
      cache: undefined,
      cacheEnabled: false,
      cwd: "/repo",
      forceRerunTriggers: ["server/agents/support/**"],
      hideTable: true,
      maxConcurrency: 1,
      mode: "watch-for-file-changes",
      outputPath: "eval-results.json",
      path: "server/agents/support.eval.ts",
      scoreThreshold: 85,
      server: undefined,
      setupFiles: undefined,
      testTimeout: 300000,
      trialCount: undefined,
    })
  })

  it("prints help without spawning Evalite", async () => {
    const stdout = stream()
    const runner = vi.fn()
    const exitCode = await runAgentEvalCli(["--help"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout,
    }, undefined, runner, vi.fn(async () => "/repo/.vitehub/agent/evalite.config.ts"))

    expect(exitCode).toBe(0)
    expect(runner).not.toHaveBeenCalled()
    expect(stdout.output()).toContain("Usage: vitehub agent eval")
  })

  it("rejects unsupported options before running Evalite", async () => {
    const stderr = stream()
    const runner = vi.fn()
    const exitCode = await runAgentEvalCli(["--config", "evalite.config.ts"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout: stream(),
    }, undefined, runner, vi.fn(async () => "/repo/.vitehub/agent/evalite.config.ts"))

    expect(exitCode).toBe(1)
    expect(runner).not.toHaveBeenCalled()
    expect(stderr.output()).toContain("Unknown option: --config")
  })

  it("writes generated Evalite config under .vitehub/agent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-eval-"))
    try {
      await writeAgentEvaliteConfig(rootDir, {
        forceRerunTriggers: ["server/agents/support/**"],
        maxConcurrency: 1,
        testTimeout: 300000,
      })

      await expect(readFile(createAgentEvaliteConfigPath(rootDir), "utf8")).resolves.toContain(`"maxConcurrency": 1`)
      await expect(readFile(createAgentEvaliteConfigPath(rootDir), "utf8")).resolves.toContain(`"testTimeout": 300000`)
      await expect(readFile(createAgentEvaliteConfigPath(rootDir), "utf8")).resolves.toContain(`"server/agents/support/**"`)
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})
