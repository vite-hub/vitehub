// @vitest-environment happy-dom
import { createApp, h, ref } from "vue"
import { afterEach, expect, it, vi } from "vitest"

import ConsoleMediaPicker from "../src/console/runtime/components/console-media-picker.vue"

import type { ConsoleMediaClient, ConsoleMediaInfo } from "../src/console/runtime/client/media-library"

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.() })

function mountPicker(info: () => Promise<ConsoleMediaInfo>) {
  const picker = ref<InstanceType<typeof ConsoleMediaPicker>>()
  const client = { info: vi.fn(info), list: vi.fn() } as unknown as ConsoleMediaClient
  const container = document.createElement("div")
  document.body.append(container)
  const app = createApp({ render: () => h(ConsoleMediaPicker, { ref: picker, client, section: "content" }) })
  app.mount(container)
  cleanup = () => { app.unmount(); container.remove() }
  return { client, picker: picker.value! }
}

const access = { manage: false, read: true, write: true }
const pending = Symbol("pending")
const settled = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<typeof pending>(resolve => setTimeout(() => resolve(pending), 20))])

it("opens a store-bound field on its first click, before the library has listed anything", async () => {
  const { client, picker } = mountPicker(async () => ({ access, served: "/media/", store: "media" }))
  const picking = picker.pick({ files: [], kind: "image", store: "media" })
  expect(await settled(picking)).toBe(pending)
  expect(client.info).toHaveBeenCalledOnce()
})

it("refuses a field bound to a store that the library does not serve", async () => {
  const { picker } = mountPicker(async () => ({ access, served: null, store: "default" }))
  await expect(picker.pick({ files: [], kind: "image", store: "media" })).resolves.toEqual([])
})

it("fails closed when the library cannot say which store it serves", async () => {
  const { picker } = mountPicker(async () => { throw new Error("offline") })
  await expect(picker.pick({ files: [], kind: "image", store: "media" })).resolves.toEqual([])
})

it("keeps the newest of two overlapping first clicks", async () => {
  let resolve!: (info: ConsoleMediaInfo) => void
  const { client, picker } = mountPicker(() => new Promise(done => { resolve = done }))
  const older = picker.pick({ files: [], kind: "image", store: "media" })
  const newer = picker.pick({ files: [], kind: "image", store: "media" })
  resolve({ access, served: "/media/", store: "media" })
  await expect(older).resolves.toEqual([])
  expect(await settled(newer)).toBe(pending)
  expect(client.info).toHaveBeenCalledOnce()
})
