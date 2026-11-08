import { afterEach, expect, it, vi } from "vitest"

import { channelSimulatorClient } from "../src/internal/channel-simulator/client.ts"

import type { SimulatorDocument, SimulatorEvent, SimulatorForm, SimulatorTextArea } from "../src/internal/channel-simulator/types.ts"

class Element implements SimulatorForm, SimulatorTextArea {
  hidden = false
  innerHTML = ""
  clientHeight = 0
  scrollHeight = 0
  scrollTop = 0
  style = { height: "" }
  textContent = ""
  value = ""
  listeners = new Map<string, (event: SimulatorEvent) => void>()
  addEventListener = (type: string, listener: (event: SimulatorEvent) => void) => { this.listeners.set(type, listener) }
  after = vi.fn()
  append = vi.fn()
  focus = vi.fn()
  remove = vi.fn()
  setAttribute = vi.fn()
  requestSubmit = () => { this.listeners.get("submit")?.({ preventDefault() {} }) }
}

function openPage() {
  const input = new Element()
  const form = new Element()
  const elements = new Map([["input", input], ["form", form], ["list", new Element()], ["scroll", new Element()]])
  const document: SimulatorDocument = {
    documentElement: { dataset: { embed: "" } },
    title: "",
    createElement: () => new Element(),
    getElementById: id => elements.get(id) ?? null,
  }
  const settled = vi.fn()
  const update = vi.fn()
  channelSimulatorClient(
    { agent: "support", platform: "Discord", route: "/hooks/support", user: "You" },
    { message: (view, index) => view.markdown(view.messages[index].text), update },
    document,
    { location: { origin: "https://example.com" }, parent: { postMessage: settled } },
  )
  input.value = "hello"
  form.requestSubmit()
  return { settled, update }
}

afterEach(() => { vi.unstubAllGlobals() })

it.each(["finish", "[DONE]"])("does not cancel a successful reply after %s while its body is still open", async (lastFrame) => {
  const encoder = new TextEncoder()
  const cancel = vi.fn()
  const pull = vi.fn()
  let tail!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      tail = controller
      controller.enqueue(encoder.encode('data: {"type":"text-delta","delta":"hello back"}\n\ndata: {"type":"finish"}\n\n'
        + (lastFrame === "[DONE]" ? "data: [DONE]\n\n" : "")))
    },
    pull,
    cancel,
  }, { highWaterMark: 0 })
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body)))
  const { settled, update } = openPage()

  // Wait for either the next read or an early exit, without relying on a frame count or a timer.
  await vi.waitFor(() => { expect(pull.mock.calls.length + settled.mock.calls.length).toBeGreaterThan(0) })
  try {
    expect(cancel).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
  }
  finally {
    if (!cancel.mock.calls.length) {
      if (lastFrame === "finish") tail.enqueue(encoder.encode("data: [DONE]\n\n"))
      tail.close()
    }
  }
  await vi.waitFor(() => { expect(settled).toHaveBeenCalledTimes(1) })
  expect(cancel).not.toHaveBeenCalled()
  expect(update.mock.lastCall?.[0]).toMatchObject({
    busy: false,
    messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "hello back" }],
  })
})
