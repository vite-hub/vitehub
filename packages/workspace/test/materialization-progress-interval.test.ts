import { afterEach, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

afterEach(() => {
  vi.restoreAllMocks()
})

it("does not report every file when the progress observer is slower than the report interval", async () => {
  let now = 1_000_000
  vi.spyOn(Date, "now").mockImplementation(() => now)
  const files = Array.from({ length: 60 }, (_, index) => ({ path: `file-${index}.md`, content: `content ${index}` }))
  const reported: number[] = []

  await materializeWorkspaceSources({
    name: "slow-progress-observer",
    sources: { docs: custom({ materialize: "startup", mount: "docs", files }) },
  }, createMemoryWorkspaceStore(), {
    onProgress(event) {
      if (event.status !== "updating") return
      reported.push(event.files ?? 0)
      // An observer that takes longer than the 1 s interval, such as a contended Invocation journal.
      now += 2_000
    },
  })

  expect(reported).toEqual([1, 25, 50])
})
