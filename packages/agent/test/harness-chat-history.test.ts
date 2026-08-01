import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createMessage, defineAgent, runAgent } from "../src/index.ts"
import { createLocalHarnessSandbox } from "../src/harness/local-sandbox.ts"

import type {
  HarnessV1,
  HarnessV1Prompt,
  HarnessV1PromptTurnOptions,
  HarnessV1StartOptions,
} from "@ai-sdk/harness"

interface CapturedTurn {
  imageBytes: number[][]
  isResume: boolean
  prompt: HarnessV1Prompt
}

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function lifecycleState<T extends "continue-turn" | "resume-session">(type: T) {
  return {
    data: {},
    harnessId: "history-test",
    specificationVersion: "harness-v1" as const,
    type,
  }
}

function createHistoryHarness(turns: CapturedTurn[]): HarnessV1 {
  return {
    builtinTools: {},
    harnessId: "history-test",
    specificationVersion: "harness-v1",
    async doStart(options: HarnessV1StartOptions) {
      return {
        isResume: options.resumeFrom !== undefined,
        sessionId: options.sessionId,
        async doCompact() {},
        async doContinueTurn() {
          throw new Error("Unexpected continuation")
        },
        async doDestroy() {},
        async doDetach() {
          return lifecycleState("resume-session")
        },
        async doPromptTurn(turn: HarnessV1PromptTurnOptions) {
          const imageParts = typeof turn.prompt === "object" && Array.isArray(turn.prompt.content)
            ? turn.prompt.content.filter(part => part.type === "image")
            : []
          const imageBytes = await Promise.all(imageParts.map(async (part) => {
            expect(typeof part.image).toBe("string")
            const bytes = await options.sandboxSession.readBinaryFile({ path: part.image as string })
            expect(bytes).not.toBeNull()
            return Array.from(bytes!)
          }))
          turns.push({
            imageBytes,
            isResume: options.resumeFrom !== undefined,
            prompt: turn.prompt,
          })
          const usage = {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 },
            outputTokens: { reasoning: 0, text: 0, total: 0 },
          }
          const finishReason = { raw: "stop", unified: "stop" as const }
          turn.emit({ type: "stream-start" })
          turn.emit({
            finishReason,
            type: "finish-step",
            usage,
          })
          turn.emit({
            finishReason,
            totalUsage: usage,
            type: "finish",
          })
          return {
            done: Promise.resolve(),
            async submitToolResult() {},
          }
        },
        async doStop() {
          return lifecycleState("resume-session")
        },
        async doSuspendTurn() {
          return lifecycleState("continue-turn")
        },
      }
    },
  }
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-harness-chat-history-"))
  roots.push(root)
  return root
}

const runtime = {
  memo<T>(_key: string, create: () => T) {
    return create()
  },
  runtime: "unknown" as const,
  waitUntil() {},
}

async function attachmentPaths(root: string) {
  return (await readdir(root, { recursive: true })).filter(path =>
    path.includes(".vitehub/attachments"),
  )
}

describe("Harness chat history", () => {
  it("projects ordered multimodal history for fresh sessions and only the latest turn when resumed", async () => {
    const root = await createRoot()
    const turns: CapturedTurn[] = []
    const agent = defineAgent({
      driver: {
        harness: createHistoryHarness(turns),
        sandbox: createLocalHarnessSandbox({ rootDir: root }),
        sessionKey: "thread-1",
      },
    })
    const input = {
      context: { chat: {} },
      messages: [
        createMessage({
          id: "historical-user",
          parts: [
            { text: "Remember the first image.", type: "text" },
            { data: new Uint8Array([1]), mediaType: "image/png", name: "../../escape.png", type: "image" },
          ],
          role: "user" as const,
        }),
        createMessage({ id: "assistant", role: "assistant" as const, text: "I remember it." }),
        createMessage({
          id: "latest-user",
          parts: [
            { text: "Compare it with these.", type: "text" },
            { data: new Uint8Array([99]), fetchData: () => new Uint8Array([2]), mediaType: "image/jpeg", type: "image" },
            { data: new Uint8Array([3]), mediaType: "image/webp", type: "image" },
            { data: "DATA:image/png;BASE64,BQ==", mediaType: "image/png", type: "image" },
            { data: new Uint8Array([4]), mediaType: "application/pdf", name: "report.pdf", type: "file" },
          ],
          role: "user" as const,
        }),
      ],
    }

    await runAgent(agent, runtime, input)
    expect(await attachmentPaths(root)).toEqual([])
    await runAgent(agent, runtime, input)
    expect(await attachmentPaths(root)).toEqual([])

    expect(turns).toHaveLength(2)
    expect(turns[0]?.isResume).toBe(false)
    expect(turns[0]?.imageBytes).toEqual([
      [1],
      [2],
      [3],
      [5],
    ])
    expect(turns[1]?.isResume).toBe(true)
    expect(turns[1]?.imageBytes).toEqual([
      [2],
      [3],
      [5],
    ])

    const freshPrompt = turns[0]?.prompt
    expect(freshPrompt).toMatchObject({ role: "user" })
    const freshContent = typeof freshPrompt === "object" && Array.isArray(freshPrompt.content) ? freshPrompt.content : []
    expect(freshContent.filter(part => part.type === "image").map(part => part.image)).toEqual([
      expect.stringMatching(/\.vitehub\/attachments\/[^/]+\/message-1-attachment-2\.png$/),
      expect.stringMatching(/\.vitehub\/attachments\/[^/]+\/message-3-attachment-2\.jpg$/),
      expect.stringMatching(/\.vitehub\/attachments\/[^/]+\/message-3-attachment-3\.webp$/),
      expect.stringMatching(/\.vitehub\/attachments\/[^/]+\/message-3-attachment-4\.png$/),
    ])
    expect(JSON.stringify(freshContent)).not.toContain("escape")
    expect(freshContent.filter(part => part.type === "text").map(part => part.text).join("")).toContain("I remember it.")
    expect(freshContent.filter(part => part.type === "text").map(part => part.text).join("")).toMatch(/report\.pdf.*\.vitehub\/attachments\/[^/]+\/message-3-attachment-5\.pdf/)

    const resumedPrompt = turns[1]?.prompt
    expect(resumedPrompt).toMatchObject({ role: "user" })
    const resumedText = typeof resumedPrompt === "object" && Array.isArray(resumedPrompt.content)
      ? resumedPrompt.content.filter(part => part.type === "text").map(part => part.text).join("")
      : ""
    expect(resumedText).toContain("Compare it with these.")
    expect(resumedText).not.toContain("Remember the first image.")
    expect(resumedText).not.toContain("I remember it.")
  })

  it("enforces one aggregate attachment budget and removes partial materialization", async () => {
    const root = await createRoot()
    const turns: CapturedTurn[] = []
    const agent = defineAgent({
      driver: {
        harness: createHistoryHarness(turns),
        sandbox: createLocalHarnessSandbox({ rootDir: root }),
      },
    })
    const thirteenMiB = new Uint8Array(13 * 1024 * 1024)
    const oversizedBlob = new Blob([])
    Object.defineProperty(oversizedBlob, "size", { value: 26 * 1024 * 1024 })
    const arrayBuffer = vi.spyOn(Blob.prototype, "arrayBuffer")

    await expect(runAgent(agent, runtime, {
      context: { chat: {} },
      messages: [createMessage({
        parts: [
          { fetchData: () => thirteenMiB, mediaType: "application/pdf", type: "file" },
          { fetchData: () => thirteenMiB, mediaType: "application/pdf", type: "file" },
        ],
        role: "user",
      })],
    })).rejects.toThrow("exceeds the remaining Harness attachment limit")

    expect(turns).toEqual([])
    expect(await attachmentPaths(root)).toEqual([])

    await expect(runAgent(agent, runtime, {
      context: { chat: {} },
      messages: [createMessage({
        parts: [{ data: oversizedBlob, mediaType: "image/png", type: "image" }],
        role: "user",
      })],
    })).rejects.toThrow("exceeds the remaining Harness attachment limit")

    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(turns).toEqual([])
    expect(await attachmentPaths(root)).toEqual([])
  })

  it("enforces the attachment budget from fetched bytes instead of declared metadata", async () => {
    const root = await createRoot()
    const turns: CapturedTurn[] = []
    const agent = defineAgent({
      driver: {
        harness: createHistoryHarness(turns),
        sandbox: createLocalHarnessSandbox({ rootDir: root }),
      },
    })

    await runAgent(agent, runtime, {
      context: { chat: {} },
      messages: [createMessage({
        parts: [{
          fetchData: () => new Uint8Array([1]),
          mediaType: "image/png",
          size: 26 * 1024 * 1024,
          type: "image",
        }],
        role: "user",
      })],
    })

    expect(turns).toHaveLength(1)
    expect(turns[0]?.imageBytes).toEqual([[1]])
    expect(await attachmentPaths(root)).toEqual([])

    const encoded = Buffer.alloc(25 * 1024 * 1024).toString("base64")
    const wrappedBase64 = `${encoded.slice(0, 76)}\n${encoded.slice(76)}`
    await runAgent(agent, runtime, {
      context: { chat: {} },
      messages: [createMessage({
        parts: [{
          fetchData: () => wrappedBase64,
          mediaType: "application/pdf",
          type: "file",
        }],
        role: "user",
      })],
    })

    expect(turns).toHaveLength(2)
    expect(await attachmentPaths(root)).toEqual([])
  })

  it("percent-decodes arbitrary data URL bytes", async () => {
    const root = await createRoot()
    const turns: CapturedTurn[] = []
    const agent = defineAgent({
      driver: {
        harness: createHistoryHarness(turns),
        sandbox: createLocalHarnessSandbox({ rootDir: root }),
      },
    })

    await runAgent(agent, runtime, {
      context: { chat: {} },
      messages: [createMessage({
        parts: [
          { data: "data:application/octet-stream,%FF%00A", mediaType: "image/png", type: "image" },
          { data: "-_8=", mediaType: "image/png", type: "image" },
        ],
        role: "user",
      })],
    })

    expect(turns[0]?.imageBytes).toEqual([[255, 0, 65], [251, 255]])
    expect(await attachmentPaths(root)).toEqual([])
  })

  it("aborts stalled Channel attachment resolution before Harness invocation", async () => {
    const root = await createRoot()
    const turns: CapturedTurn[] = []
    const controller = new AbortController()
    let markFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const agent = defineAgent({
      driver: {
        harness: createHistoryHarness(turns),
        sandbox: createLocalHarnessSandbox({ rootDir: root }),
      },
    })

    const invocation = runAgent(agent, runtime, {
      abortSignal: controller.signal,
      context: { chat: {} },
      messages: [createMessage({
        parts: [{
          fetchData: () => {
            markFetchStarted()
            return new Promise<Uint8Array>(() => {})
          },
          mediaType: "image/png",
          type: "image",
        }],
        role: "user",
      })],
    })
    await fetchStarted
    controller.abort(new Error("request closed"))

    await expect(invocation).rejects.toThrow("request closed")
    expect(turns).toEqual([])
    expect(await attachmentPaths(root)).toEqual([])
  })

  it("rejects invalid Channel adapter data instead of using fallback attachment data", async () => {
    const root = await createRoot()
    const turns: CapturedTurn[] = []
    const agent = defineAgent({
      driver: {
        harness: createHistoryHarness(turns),
        sandbox: createLocalHarnessSandbox({ rootDir: root }),
      },
    })

    await expect(runAgent(agent, runtime, {
      context: { chat: {} },
      messages: [createMessage({
        parts: [{
          data: new Uint8Array([1]),
          fetchData: () => undefined as never,
          mediaType: "image/png",
          type: "image",
        }],
        role: "user",
      })],
    })).rejects.toThrow("fetchData() did not return supported attachment data")

    expect(turns).toEqual([])
    expect(await attachmentPaths(root)).toEqual([])
  })

  it("rejects URL-only attachments before invoking the Harness turn", async () => {
    const root = await createRoot()
    const turns: CapturedTurn[] = []
    const agent = defineAgent({
      driver: {
        harness: createHistoryHarness(turns),
        sandbox: createLocalHarnessSandbox({ rootDir: root }),
      },
    })

    await expect(runAgent(agent, runtime, {
      context: { chat: {} },
      messages: [createMessage({
        parts: [{ mediaType: "image/png", type: "image", url: "https://cdn.example.com/photo.png" }],
        role: "user",
      })],
    })).rejects.toThrow("URL-only attachments must be resolved by the Channel adapter")

    expect(turns).toEqual([])
    expect(await attachmentPaths(root)).toEqual([])
  })

  it("rejects attachments before invocation when a custom sandbox cannot remove directories", async () => {
    const root = await createRoot()
    const turns: CapturedTurn[] = []
    const sandbox = createLocalHarnessSandbox({ rootDir: root })
    const agent = defineAgent({
      driver: {
        harness: createHistoryHarness(turns),
        sandbox: {
          ...sandbox,
          async createSession(options: Parameters<typeof sandbox.createSession>[0]) {
            const session = await sandbox.createSession(options)
            delete (session as unknown as Record<symbol, unknown>)[Symbol.for("vitehub.harnessRemoveDirectory")]
            return session
          },
        },
      },
    })

    await expect(runAgent(agent, runtime, {
      context: { chat: {} },
      messages: [createMessage({
        parts: [{ data: new Uint8Array([1]), mediaType: "image/png", type: "image" }],
        role: "user",
      })],
    })).rejects.toThrow("requires sandbox directory removal support")

    expect(turns).toEqual([])
    expect(await attachmentPaths(root)).toEqual([])
  })
})
