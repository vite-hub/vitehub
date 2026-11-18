// The page of the Sync bench: a Vue list with one child component per row, over the real IndexedDB storage and the
// fake server in the page. `bench.browser.mjs` bundles it and calls `window.bench`.
import { createApp, defineComponent, h, nextTick } from "vue"

import { clearSync } from "../../src/client.ts"
import { useSync } from "../../src/vue.ts"
import { createFakeSyncServer } from "../client-fake-server.ts"

import type { PropType } from "vue"
import type { SyncRow } from "../../src/protocol.ts"

interface Row { id: string, ownerId: string, title: string }

const server = createFakeSyncServer()
// The steps of `run()` pull with `refresh()`, so they compare with clients that have no live stream. `live()` streams.
server.live = false
let rowRenders = 0

const Item = defineComponent({
  props: { todo: { type: Object as PropType<Row>, required: true } },
  setup(props) {
    return () => {
      rowRenders++
      return h("li", { "data-id": props.todo.id }, props.todo.title)
    }
  },
})

let todos!: ReturnType<typeof useSync<"todos">>

function mount(): HTMLUListElement {
  const List = defineComponent({
    setup() {
      todos = useSync("todos", { fetch: server.fetch, interval: false })
      return () => h("ul", todos.rows.map(todo => h(Item, { key: String(todo.id), todo: todo as unknown as Row })))
    },
  })
  const root = document.createElement("div")
  document.body.append(root)
  createApp(List).mount(root)
  return root.querySelector("ul") ?? root.appendChild(document.createElement("ul"))
}

/** Resolves once `check` passes, after Vue flushed. Checks after each microtask flush, then each macrotask. */
async function until(check: () => boolean): Promise<void> {
  await nextTick()
  while (!check()) await new Promise(resolve => setTimeout(resolve, 0))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function titleOf(list: HTMLElement, index: number): string | null {
  return list.children[index]?.textContent ?? null
}

const count = 10_000
const keyOf = (index: number) => `row-${String(index).padStart(5, "0")}`

async function settle(): Promise<void> {
  await until(() => todos.queued === 0)
}

/** Fills the server, mounts the list, and measures the steps of the bench. */
async function run(rounds = 15): Promise<Record<string, number>> {
  await clearSync()
  for (let index = 0; index < count; index++) server.write({ id: keyOf(index), ownerId: "ada", title: `Task ${index}` } satisfies SyncRow)
  const startSync = performance.now()
  const list = mount()
  await until(() => list.children.length === count)
  const firstSync = performance.now() - startSync
  await settle()

  const update: number[] = []
  const updateSettled: number[] = []
  const updateRenders: number[] = []
  for (let round = 0; round < rounds; round++) {
    const index = (round * 613) % count
    const title = `Updated ${round}`
    rowRenders = 0
    const start = performance.now()
    todos.update(keyOf(index), { title })
    await until(() => titleOf(list, index) === title)
    update.push(performance.now() - start)
    await settle()
    updateSettled.push(performance.now() - start)
    updateRenders.push(rowRenders)
  }

  const pull: number[] = []
  const pullRenders: number[] = []
  for (let round = 0; round < rounds; round++) {
    const index = (round * 389 + 7) % count
    const title = `Pulled ${round}`
    server.write({ id: keyOf(index), ownerId: "ada", title })
    rowRenders = 0
    const start = performance.now()
    void todos.refresh()
    await until(() => titleOf(list, index) === title)
    pull.push(performance.now() - start)
    pullRenders.push(rowRenders)
  }
  await settle()

  const burst: number[] = []
  const burstSettled: number[] = []
  const burstRenders: number[] = []
  for (let round = 0; round < Math.min(rounds, 5); round++) {
    rowRenders = 0
    const start = performance.now()
    for (let index = 0; index < 100; index++) todos.update(keyOf(index * 97), { title: `Burst ${round}.${index}` })
    await until(() => titleOf(list, 99 * 97) === `Burst ${round}.99`)
    burst.push(performance.now() - start)
    await settle()
    burstSettled.push(performance.now() - start)
    burstRenders.push(rowRenders)
  }

  return {
    "first sync, 10k rows from the network (ms)": firstSync,
    "update to DOM (ms)": median(update),
    "update until confirmed (ms)": median(updateSettled),
    "row renders per update": median(updateRenders),
    "pull of one changed row to DOM (ms)": median(pull),
    "row renders per pull": median(pullRenders),
    "burst of 100 updates to DOM (ms)": median(burst),
    "burst of 100 updates until confirmed (ms)": median(burstSettled),
    "row renders per burst": median(burstRenders),
  }
}

/** After a reload: streams, and measures a change on the server until the DOM shows it. Only clients with `live`. */
async function live(rounds = 15): Promise<Record<string, number>> {
  await clearSync()
  server.live = true
  for (let index = 0; index < count; index++) server.write({ id: keyOf(index), ownerId: "ada", title: `Task ${index}` } satisfies SyncRow)
  const list = mount()
  await until(() => list.children.length === count)
  const state = todos as unknown as { live?: boolean }
  if (state.live === undefined) return {}
  await until(() => state.live === true)
  const times: number[] = []
  for (let round = 0; round < rounds; round++) {
    const index = (round * 389 + 11) % count
    const title = `Live ${round}`
    const start = performance.now()
    server.write({ id: keyOf(index), ownerId: "ada", title })
    await until(() => titleOf(list, index) === title)
    times.push(performance.now() - start)
  }
  await clearSync()
  return { "server change to DOM over the live stream (ms)": median(times) }
}

/** After a reload: mounts with the server offline and measures the first paint of the stored rows. */
async function paint(): Promise<Record<string, number>> {
  server.offline = true
  const start = performance.now()
  const list = mount()
  await until(() => list.children.length === count)
  const time = performance.now() - start
  server.offline = false
  await clearSync()
  return { "first paint, 10k rows from IndexedDB (ms)": time }
}

declare global {
  interface Window {
    bench: { run: typeof run, paint: typeof paint, live: typeof live }
  }
}

window.bench = { run, paint, live }
