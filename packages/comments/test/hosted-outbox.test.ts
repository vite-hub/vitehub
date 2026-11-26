// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"

import { commentsUnansweredError } from "../src/client-diagnostics.ts"
import { createCommentsClient, createMemoryOutboxStore } from "../src/client.ts"
import { mountHostedComments } from "../src/embed/tools.ts"
import { createMemoryTransport } from "../src/operations-core/testing.ts"
import { createOverlayTransport, overlayOutboxNamespace } from "../src/overlay/api.ts"

import type { CommentsOutboxStore } from "../src/client.ts"
import type { EmbedFrame, EmbedMethod } from "../src/embed/protocol.ts"
import type { CommentUser } from "../src/types.ts"

vi.mock("@vite-hub/internal/runtime/page-tools-loader", () => ({ loadViteHubPageTools: vi.fn(), stopViteHubPageTools: vi.fn() }))

const ana: CommentUser = { id: "u1", name: "Ana Ruiz" }
const consoleOrigin = "https://console.example.com"
const subject = { kind: "page", id: "/guide" }
const anchor = { kind: "element", selector: "h1", x: 500, y: 500 } as const

function projectFrame() {
  const memory = createMemoryTransport({ user: ana, users: [ana] })
  const project = { online: true, creates: [] as string[] }
  const frame: EmbedFrame = {
    async call(method: EmbedMethod, input: unknown) {
      if (!project.online) throw commentsUnansweredError(0)
      if (method === "create") project.creates.push((input as { body: string }).body)
      // SAFETY: the test sends only the methods of the overlay transport, with their inputs.
      const value: unknown = await (memory[method as "create"] as (input: unknown) => Promise<unknown>)(input)
      return { id: 0, ok: true, value, people: [] }
    },
    onChange: () => () => undefined,
  }
  return Object.assign(project, { frame: Promise.resolve(frame) })
}

async function mount(frame: Promise<EmbedFrame>, id: string, store: CommentsOutboxStore) {
  await mountHostedComments(frame, { id, console: consoleOrigin })
  const client = createCommentsClient({
    transport: createOverlayTransport({ onPeople: () => undefined, onChange: () => undefined }),
    user: ana,
    outbox: { account: ana.id, namespace: overlayOutboxNamespace(), store },
  })
  const stop = client.start()
  return { client, stop }
}

describe("the hosted overlay outbox", () => {
  it("sends a comment saved under one project only through that project's frame", async () => {
    const store = createMemoryOutboxStore()
    const a = projectFrame()
    const b = projectFrame()
    a.online = false

    const first = await mount(a.frame, "p-1", store)
    await first.client.create({ subject, anchor, body: "For project A" })
    await vi.waitFor(() => expect(first.client.outbox!.entries).toHaveLength(1))
    first.stop()

    const second = await mount(b.frame, "p-2", store)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.creates).toEqual([])
    expect(second.client.outbox!.entries).toEqual([])
    second.stop()

    a.online = true
    const third = await mount(a.frame, "p-1", store)
    await vi.waitFor(() => expect(a.creates).toEqual(["For project A"]))
    await vi.waitFor(() => expect(third.client.outbox!.entries).toEqual([]))
    third.stop()
    expect(b.creates).toEqual([])
  })
})
