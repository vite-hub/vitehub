// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, h } from "vue"
import { describe, expect, it, vi } from "vitest"

import { contentHeadStatus, contentWebhookResult } from "../src/console/runtime/client/content-heads"
import { ConsoleRequestError } from "../src/console/runtime/client/request"

import type { ConsoleContentHead } from "../src/console/runtime/client/content-heads"

const operation = vi.hoisted(() => vi.fn())
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsoleOperation: operation,
}))
vi.mock("@vite-hub/ui", () => ({ Status: defineComponent({ props: { label: String, tone: String }, setup: props => () => h("span", { "data-tone": props.tone }, props.label) }) }))
vi.mock("../src/console/runtime/components/console-relative-time.vue", () => ({ default: defineComponent({ props: { value: String }, setup: props => () => h("time", props.value) }) }))
vi.mock("../src/console/runtime/components/console-state.vue", () => ({ default: defineComponent({ props: { title: String }, setup: props => () => h("p", { role: "alert" }, props.title) }) }))

import ContentHeads from "../src/console/runtime/components/console-content-heads.vue"

const docs: ConsoleContentHead = {
  source: "docs",
  live: true,
  sha: "4f9c2e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f",
  ref: "main",
  movedAt: "2026-11-18T09:00:00.000Z",
  pinned: true,
  rejected: null,
  webhook: { id: "d1", at: "2026-11-18T10:00:00.000Z", sha: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b", result: "pinned" },
  diagnostic: null,
}

async function render(answer: () => unknown) {
  operation.mockReset()
  operation.mockImplementation(async () => answer())
  const wrapper = mount(ContentHeads)
  await flushPromises()
  return wrapper
}

describe("Content Source heads", () => {
  it("shows the served commit, the pin, and the last push webhook of each github() Source", async () => {
    const blog: ConsoleContentHead = { ...docs, source: "blog", pinned: false, webhook: null, diagnostic: { code: "CONTENT_R0019", message: "Commit 1234567 failed validation.", fix: "Fix the document and push again." } }
    const wrapper = await render(() => ({ heads: [docs, blog] }))
    expect(operation).toHaveBeenCalledWith("content.head", {}, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const [first, second] = wrapper.findAll("li").map(item => item.text())
    expect(first).toContain("docs")
    expect(first).toContain("Pinned")
    expect(first).toContain("main at 4f9c2e1, moved 2026-11-18T09:00:00.000Z")
    expect(first).toContain("Last push 2026-11-18T10:00:00.000Z: Kept the pin, ignored 9a8b7c6")
    expect(second).toContain("Held back")
    expect(second).toContain("No push webhook yet")
    expect(second).toContain("Commit 1234567 failed validation. Fix the document and push again.")
  })

  it("stays hidden for an app without a github() Source", async () => {
    const wrapper = await render(() => ({ heads: [] }))
    expect(wrapper.html()).toBe("<!--v-if-->")
  })

  it("shows a failed read in its place", async () => {
    const wrapper = await render(() => { throw new ConsoleRequestError(503, "Unavailable") })
    expect(wrapper.find("[role=alert]").text()).toBe("Couldn't load the Source heads")
  })

  it("names the head state and the webhook result", () => {
    expect(contentHeadStatus({ live: false, pinned: false, diagnostic: null })).toEqual({ label: "Not live", tone: "neutral" })
    expect(contentHeadStatus({ live: true, pinned: false, diagnostic: null })).toEqual({ label: "Live", tone: "success" })
    expect(contentWebhookResult({ id: null, at: "", sha: "4f9c2e1a7b", result: "moved" })).toEqual({ label: "Moved the head to 4f9c2e1", tone: "success" })
    expect(contentWebhookResult({ id: null, at: "", sha: null, result: "failed", error: "GitHub answered 502" })).toEqual({ label: "Failed: GitHub answered 502", tone: "error" })
  })
})
