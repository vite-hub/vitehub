import { expect, it } from "vitest"

import { chunkGrowth } from "../scripts/console-weight/chunk-growth.mjs"
import { memoryVerdict } from "../scripts/console-weight/memory-verdict.mjs"
import { startupGrowth } from "../scripts/console-weight/startup-growth.mjs"

const original = { fingerprint: "original", owners: { workspace: 10 } }

it("a renamed exact match consumes the baseline for a changed chunk", () => {
  const off = { "a.mjs": original }
  const on = { "a.mjs": { ...original, fingerprint: "modified" }, "b.mjs": original }
  expect(chunkGrowth(off, on)).toEqual([{ chunk: "a.mjs", owner: "workspace", bytes: 10, added: false }])
})

it("an exact match at the same name wins over a renamed copy", () => {
  expect(chunkGrowth({ "a.mjs": original }, { "b.mjs": original, "a.mjs": original }))
    .toEqual([{ chunk: "b.mjs", owner: "workspace", bytes: 10, added: true }])
})

it("a changed chunk can subtract an unclaimed baseline at the same name", () => {
  const modified = { fingerprint: "modified", owners: { workspace: 12 } }
  expect(chunkGrowth({ "a.mjs": original }, { "a.mjs": modified }))
    .toEqual([{ chunk: "a.mjs", owner: "workspace", bytes: 2, added: false }])
})

it("a renamed chunk prefers an exact match with no same-name fallback", () => {
  const off = { "a.mjs": original, "b.mjs": original }
  const on = { "b.mjs": { ...original, fingerprint: "modified" }, "c.mjs": original }
  expect(chunkGrowth(off, on)).toEqual([])
})

it("a module that moves to another startup chunk is not startup growth", () => {
  const off = { "packages/kv/src/index.ts": 900, "node_modules/h3/dist/index.mjs": 4000 }
  const on = { "node_modules/h3/dist/index.mjs": 4000, "packages/kv/src/index.ts": 900 }
  expect(startupGrowth(off, on)).toEqual({ added: [], grown: [], bytes: 0 })
})

it("an added startup module and a grown startup module are startup growth", () => {
  const off = { "packages/kv/src/index.ts": 900 }
  const on = { "packages/kv/src/index.ts": 950, "packages/vite-hub/src/console/rpc.ts": 3000 }
  expect(startupGrowth(off, on)).toEqual({
    added: [{ source: "packages/vite-hub/src/console/rpc.ts", bytes: 3000 }],
    grown: [{ source: "packages/kv/src/index.ts", bytes: 50 }],
    bytes: 3050,
  })
})

it("bytes that the sourcemap traces to a different startup module are not startup growth", () => {
  const off = { "node_modules/comark/dist/internal/bracket-math.js": 30000, "node_modules/comark/dist/plugins/linkify.js": 100 }
  const on = { "node_modules/comark/dist/internal/bracket-math.js": 1900, "node_modules/comark/dist/plugins/linkify.js": 28200 }
  expect(startupGrowth(off, on).bytes).toBe(0)
})

const MB = 1000 * 1000
const rss = (values: number[]) => values.map(value => value * MB)

it("memory passes when Console on is inside the off A to off B noise", () => {
  const verdict = memoryVerdict({ offA: rss([101.3, 103.1, 102.7, 102.5, 102.6]), on: rss([102.5, 102.2, 103.4, 102.8, 102.0]), offB: rss([102.8, 102.8, 103.2, 101.1, 101.1]) })
  expect(verdict.result).toBe("PASS")
})

it("memory fails when Console on adds more than twice the noise", () => {
  const verdict = memoryVerdict({ offA: rss([102.0, 101.6, 102.3, 101.6, 101.2]), on: rss([106.5, 106.7, 106.7, 106.1, 106.0]), offB: rss([102.5, 101.5, 102.2, 102.1, 100.7]) })
  expect(verdict.result).toBe("FAIL")
})

it("memory is inconclusive when off A and off B differ by more than 1.5 MB", () => {
  const verdict = memoryVerdict({ offA: rss([100, 104, 100, 104, 100]), on: rss([102, 102, 102, 102, 102]), offB: rss([104, 100, 104, 100, 104]) })
  expect(verdict.result).toBe("INCONCLUSIVE")
})
