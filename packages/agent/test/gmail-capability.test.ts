import { describe, expect, it, vi } from "vitest"

import { validateAgentCapabilityComposition, validateCapabilityRuntimeRequirement } from "../src/capability-runtime.ts"
import { gmail } from "../src/capabilities.ts"
import { createAgentInspectionMetadata, defineAgent } from "../src/index.ts"

import type { AgentCapabilityDefinition, AgentToolSet } from "../src/types.ts"
import type { ExecResult, WorkspaceSession } from "@vite-hub/workspace"

type CommandHandler = (args: string[]) => ExecResult | Promise<ExecResult>

async function capabilityTools(capability: AgentCapabilityDefinition, handler: CommandHandler) {
  if (typeof capability.tools !== "function") throw new Error("gmail capability must expose a tool resolver")
  const sessions: Array<WorkspaceSession & { close: ReturnType<typeof vi.fn>, exec: ReturnType<typeof vi.fn> }> = []
  const startSession = vi.fn(async () => {
    const session = {
      close: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      exec: vi.fn(async (command: string, args: string[] = [], options?: { timeout?: number }) => {
        expect(command).toBe("gog")
        expect(options?.timeout).toBe(60_000)
        return await handler(args)
      }),
    } as unknown as WorkspaceSession & { close: ReturnType<typeof vi.fn>, exec: ReturnType<typeof vi.fn> }
    sessions.push(session)
    return session
  })
  const tools = await capability.tools({ workspace: { startSession } } as never) as AgentToolSet
  return { sessions, startSession, tools }
}

function result(stdout: string, exitCode = 0, stderr = ""): ExecResult {
  return { args: [], command: "gog", exitCode, stderr, stdout }
}

describe("gmail capability", () => {
  it("defines the read and draft tool boundaries with explicit runtime requirements", async () => {
    const read = gmail()
    const readRuntime = await capabilityTools(read, () => result('{"accounts":[]}'))
    const readWorkspace = read.workspace as { sources: Record<string, { content: string }> }

    expect(read).toMatchObject({
      id: "gmail",
      metadata: { command: "gog", mode: "read", skillPath: "skills/gmail/SKILL.md", sourceKey: "skill.gmail" },
      mode: "read",
      requires: [
        { primitive: "workspace", workspace: { mode: "write", required: true } },
        { primitive: "box" },
      ],
    })
    expect(read.bash).toBeUndefined()
    expect(Object.keys(readRuntime.tools).sort()).toEqual(["gmail_auth", "gmail_search"])
    expect(readWorkspace.sources["skill.gmail"]!.content).toContain("Use `gmail_search`")
    expect(readWorkspace.sources["skill.gmail"]!.content).toContain("authorization codes separately from the required full redirect URL")
    expect(readWorkspace.sources["skill.gmail"]!.content).toContain("using the `access` returned")
    expect(readWorkspace.sources["skill.gmail"]!.content).not.toContain("gog")
    expect(readWorkspace.sources["skill.gmail"]!.content).not.toContain("shell")
    expect(() => gmail({ mode: "send" as never })).toThrow('must be "read" or "draft"')
    expect(() => validateAgentCapabilityComposition([read], { hasBox: false, hasWorkspace: true, workspaceMode: "write" }))
      .toThrow("requires defineAgent({ box })")
    await expect(validateCapabilityRuntimeRequirement(read, { fs: { exists: vi.fn() } } as never, "read"))
      .rejects.toThrow('requires workspace.mode: "write"')
    expect(() => read.prepare!({ driver: { kind: "harness" } } as never)).not.toThrow()
    expect(() => read.prepare!({ driver: { kind: "model" } } as never)).toThrow("requires a Harness Agent Driver")

    const draft = gmail({ mode: "draft" })
    const draftRuntime = await capabilityTools(draft, () => result('{"accounts":[]}'))
    const draftWorkspace = draft.workspace as { sources: Record<string, { content: string }> }
    expect(draft).toMatchObject({ metadata: { mode: "draft" }, mode: "write" })
    expect(Object.keys(draftRuntime.tools).sort()).toEqual(["gmail_auth", "gmail_draft", "gmail_search"])
    expect(draftWorkspace.sources["skill.gmail"]!.content).toContain("create an unsent draft")

    const inspected = createAgentInspectionMetadata(defineAgent({
      box: { runtime: "trusted-host" },
      capabilities: [draft],
      driver: "codex",
      workspace: { mode: "write" },
    }))
    expect(inspected.tools).toContainEqual(expect.objectContaining({
      commands: ["gmail_auth", "gmail_search", "gmail_draft"],
      name: "gmail",
    }))
  })

  it("returns structured authorization states and validates the continuation", async () => {
    let state: "compose-only" | "connected" | "configuration" | "disconnected" | "invalid-url" = "connected"
    const calls: string[][] = []
    const runtime = await capabilityTools(gmail(), (args) => {
      calls.push(args)
      if (args[0] === "auth" && args[1] === "list") {
        return result(state === "connected"
          ? '{"accounts":[{"email":"test@example.com","services":["gmail"],"scopes":["https://www.googleapis.com/auth/gmail.readonly"],"valid":true}]}'
          : state === "compose-only"
            ? '{"accounts":[{"email":"test@example.com","services":["gmail"],"scopes":["https://www.googleapis.com/auth/gmail.compose"],"valid":true}]}'
            : '{"accounts":[]}')
      }
      if (args.includes("--step") && args.includes("1")) {
        return state === "configuration"
          ? result("", 1, "No OAuth client credentials stored")
          : result(state === "invalid-url"
            ? '{"auth_url":"https://example.com/phishing"}'
            : '{"auth_url":"https://accounts.google.com/o/oauth2/auth?state=test"}')
      }
      if (args.includes("--step") && args.includes("2")) return result('{"account":"test@example.com"}')
      if (args[0] === "gmail" && args[1] === "search") return result('{"threads":[{"id":"thread-1","subject":"Hello"}]}')
      throw new Error(`Unexpected gog args: ${args.join(" ")}`)
    })

    await expect(runtime.tools.gmail_auth!.execute?.({ action: "start", account: "test@example.com" })).resolves.toEqual({
      account: "test@example.com",
      status: "connected",
    })
    await expect(runtime.tools.gmail_search!.execute?.({ max: 50, query: "-from:spam@example.com" })).resolves.toEqual({
      account: "test@example.com",
      result: { threads: [{ id: "thread-1", subject: "Hello" }] },
      status: "ok",
    })
    expect(calls).toContainEqual([
      "gmail", "search", "--account", "test@example.com", "--max", "50",
      "--json", "--no-input", "--readonly", "--gmail-no-send", "--wrap-untrusted",
      "--", "-from:spam@example.com",
    ])

    state = "compose-only"
    await expect(runtime.tools.gmail_auth!.execute?.({ action: "start", account: "test@example.com" })).resolves.toMatchObject({
      status: "authorization_required",
    })

    state = "disconnected"
    await expect(runtime.tools.gmail_auth!.execute?.({ action: "start", account: "test@example.com" })).resolves.toEqual({
      access: "read",
      account: "test@example.com",
      authorizationUrl: "https://accounts.google.com/o/oauth2/auth?state=test",
      status: "authorization_required",
    })
    expect(calls).toContainEqual([
      "auth", "add", "test@example.com", "--services", "gmail", "--readonly",
      "--remote", "--step", "1", "--json", "--no-input",
    ])

    state = "configuration"
    await expect(runtime.tools.gmail_auth!.execute?.({ action: "start", account: "test@example.com" })).resolves.toEqual({
      setupUrl: "https://github.com/openclaw/gogcli/blob/main/docs/quickstart.md",
      status: "configuration_required",
    })

    state = "invalid-url"
    await expect(runtime.tools.gmail_auth!.execute?.({ action: "start", account: "test@example.com" }))
      .rejects.toThrow("could not start authorization")

    await expect(runtime.tools.gmail_auth!.execute?.({
      action: "complete",
      account: "test@example.com",
      redirectUrl: "https://example.com/?code=x&state=y",
    })).rejects.toThrow("HTTP localhost URL containing code and state")
    await expect(runtime.tools.gmail_auth!.execute?.({
      action: "complete",
      account: "test@example.com",
      redirectUrl: "http://localhost:8080/?code=x&state=y",
    })).resolves.toEqual({ account: "test@example.com", status: "connected" })
    expect(runtime.sessions.every(session => session.close.mock.calls.length === 1)).toBe(true)
  })

  it("creates drafts with no-send and rejects invalid input before command execution", async () => {
    let connected = true
    const calls: string[][] = []
    const runtime = await capabilityTools(gmail({ mode: "draft" }), (args) => {
      calls.push(args)
      if (args[0] === "auth" && args[1] === "list") {
        return result(connected
          ? '{"accounts":[{"email":"test@example.com","services":["gmail"],"scopes":["https://mail.google.com/"],"valid":true}]}'
          : '{"accounts":[]}')
      }
      if (args.includes("--step") && args.includes("1")) return result('{"auth_url":"https://accounts.google.com/o/oauth2/auth?state=test"}')
      if (args[0] === "gmail" && args[1] === "drafts") return result('{"draft":{"id":"draft-1"}}')
      throw new Error(`Unexpected gog args: ${args.join(" ")}`)
    })

    await expect(runtime.tools.gmail_draft!.execute?.({
      bcc: [],
      body: "Draft body",
      cc: [],
      subject: "Hello",
      to: ["person@example.com"],
    })).resolves.toEqual({
      account: "test@example.com",
      result: { draft: { id: "draft-1" } },
      status: "ok",
    })
    const draftCall = calls.find(args => args[0] === "gmail" && args[1] === "drafts")!
    expect(draftCall).toContain("--gmail-no-send")
    expect(draftCall).not.toContain("send")

    await expect(runtime.tools.gmail_draft!.execute?.({
      body: "  Indented body\n\n",
      subject: "Whitespace",
      to: ["person@example.com"],
    })).resolves.toMatchObject({ status: "ok" })
    const whitespaceDraftCall = calls.findLast(args => args[0] === "gmail" && args[1] === "drafts")!
    expect(whitespaceDraftCall[whitespaceDraftCall.indexOf("--body") + 1]).toBe("  Indented body\n\n")

    connected = false
    await expect(runtime.tools.gmail_auth!.execute?.({ action: "start", account: "test@example.com" })).resolves.toMatchObject({
      status: "authorization_required",
    })
    expect(calls).toContainEqual([
      "auth", "add", "test@example.com", "--services", "gmail", "--gmail-scope", "full",
      "--remote", "--step", "1", "--json", "--no-input",
    ])

    connected = true
    const ambiguous = await capabilityTools(gmail({ mode: "draft" }), args => args[0] === "auth"
      ? result('{"accounts":[{"email":"draft@example.com","services":["gmail"],"scopes":["https://mail.google.com/"],"valid":true},{"email":"read@example.com","services":["gmail"],"scopes":["https://www.googleapis.com/auth/gmail.readonly"],"valid":true}]}')
      : result('{"draft":{"id":"unexpected"}}'))
    await expect(ambiguous.tools.gmail_draft!.execute?.({
      body: "Body",
      subject: "Choose an account",
      to: ["person@example.com"],
    })).resolves.toEqual({ status: "account_required" })
    expect(ambiguous.sessions).toHaveLength(1)

    const beforeInvalidInput = calls.length
    await expect(runtime.tools.gmail_draft!.execute?.({
      body: "Body",
      subject: "Hello",
      to: ["first@example.com,second@example.com"],
    })).rejects.toThrow("valid email address")
    await expect(runtime.tools.gmail_draft!.execute?.({
      body: "Body\0",
      subject: "Hello",
      to: ["person@example.com"],
    })).rejects.toThrow("gmail_draft body")
    await expect(runtime.tools.gmail_search!.execute?.({ max: 51 })).rejects.toThrow("integer from 1 to 50")
    expect(calls).toHaveLength(beforeInvalidInput)
  })

  it("keeps searches on read authorization in draft mode", async () => {
    const calls: string[][] = []
    const runtime = await capabilityTools(gmail({ mode: "draft" }), (args) => {
      calls.push(args)
      if (args[0] === "auth" && args[1] === "list") {
        return result('{"accounts":[{"email":"test@example.com","services":["gmail"],"scopes":["https://www.googleapis.com/auth/gmail.readonly"],"valid":true}]}')
      }
      if (args[0] === "gmail" && args[1] === "search") return result('{"threads":[]}')
      throw new Error(`Unexpected gog args: ${args.join(" ")}`)
    })

    await expect(runtime.tools.gmail_search!.execute?.({ account: "test@example.com" })).resolves.toMatchObject({
      status: "ok",
    })
    expect(calls.some(args => args.includes("--gmail-scope"))).toBe(false)
  })

  it("closes the Box-backed Workspace Session when a Gmail command fails", async () => {
    const runtime = await capabilityTools(gmail(), (args) => args[0] === "auth"
      ? result('{"accounts":[{"email":"test@example.com","services":["gmail"],"scopes":["https://www.googleapis.com/auth/gmail.readonly"],"valid":true}]}')
      : result("", 2, "search failed"))

    await expect(runtime.tools.gmail_search!.execute?.({ query: "in:inbox" })).rejects.toThrow("gmail_search failed")
    expect(runtime.sessions).toHaveLength(2)
    expect(runtime.sessions.every(session => session.close.mock.calls.length === 1)).toBe(true)
  })
})
