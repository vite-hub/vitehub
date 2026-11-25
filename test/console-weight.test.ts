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
  expect(startupGrowth({ sources: off, unmapped: 0 }, { sources: on, unmapped: 0 })).toEqual({
    added: [], grown: [], bytes: 0, unmappedBytes: 0, result: "PASS",
  })
})

it("an added startup module and a grown startup module are startup growth", () => {
  const off = { "packages/kv/src/index.ts": 900 }
  const on = { "packages/kv/src/index.ts": 950, "packages/vite-hub/src/console/rpc.ts": 3000 }
  expect(startupGrowth({ sources: off, unmapped: 0 }, { sources: on, unmapped: 0 })).toEqual({
    added: [{ source: "packages/vite-hub/src/console/rpc.ts", bytes: 3000 }],
    grown: [{ source: "packages/kv/src/index.ts", bytes: 50 }],
    bytes: 3050,
    unmappedBytes: 0,
    result: "FAIL",
  })
})

it("bytes that the sourcemap traces to a different startup module are not startup growth", () => {
  const off = { "node_modules/comark/dist/internal/bracket-math.js": 30000, "node_modules/comark/dist/plugins/linkify.js": 100 }
  const on = { "node_modules/comark/dist/internal/bracket-math.js": 1900, "node_modules/comark/dist/plugins/linkify.js": 28200 }
  expect(startupGrowth({ sources: off, unmapped: 0 }, { sources: on, unmapped: 0 }).bytes).toBe(0)
})

it("growth in an existing startup dependency with empty mappings is inconclusive", () => {
  const off = { sources: { "<app>/server/logs.ts": 1000 }, unmapped: 5000 }
  const on = { sources: { "<app>/server/logs.ts": 941 }, unmapped: 9074 }
  expect(startupGrowth(off, on)).toMatchObject({ added: [], bytes: -59, unmappedBytes: 4074, result: "INCONCLUSIVE" })
})

it("startup uses the combined delta for uncertainty and fails on proven growth", () => {
  const off = { sources: { "<app>/server/logs.ts": 1000 }, unmapped: 1000 }
  expect(startupGrowth(off, { sources: { "<app>/server/logs.ts": 1600 }, unmapped: 1400 }).result).toBe("PASS")
  expect(startupGrowth(off, { sources: { "<app>/server/logs.ts": 1600 }, unmapped: 1401 }).result).toBe("INCONCLUSIVE")
  expect(startupGrowth(off, { sources: { "<app>/server/logs.ts": 2001 }, unmapped: 0 }).result).toBe("FAIL")
})

const MB = 1000 * 1000
const rss = (values: number[]) => values.map(value => value * MB)

it("memory passes when the full range fits the fixed budget", () => {
  const verdict = memoryVerdict({ offA: rss([100, 100, 101]), on: rss([100.5, 100.5, 101.5]), offB: rss([101, 101, 102]) })
  expect(verdict).toMatchObject({ result: "PASS", lower: -0.5 * MB, upper: 0.5 * MB })
})

it("memory fails when a consistent increase exceeds the budget despite off/off noise", () => {
  const gaps = [0, 2, 2, 0, 0, 2, 0]
  const verdict = memoryVerdict({ offA: rss(gaps.map(() => 100)), on: rss(gaps.map(gap => 101.6 + gap / 2)), offB: rss(gaps.map(gap => 100 + gap)) })
  expect(verdict).toMatchObject({ result: "FAIL", change: 1.6 * MB, lower: 1.6 * MB, upper: 1.6 * MB })
})

it("memory fails when the full range is below the negative budget", () => {
  const verdict = memoryVerdict({ offA: rss([100]), on: rss([99]), offB: rss([101]) })
  expect(verdict.result).toBe("FAIL")
})

it("memory is inconclusive when the range overlaps the budget", () => {
  const verdict = memoryVerdict({ offA: rss([100]), on: rss([101]), offB: rss([101]) })
  expect(verdict).toMatchObject({ result: "INCONCLUSIVE", lower: 0, upper: MB })
})

it("memory is inconclusive when off A and off B differ by more than 1.5 MB", () => {
  const verdict = memoryVerdict({ offA: rss([100, 104, 100, 104, 100]), on: rss([102, 102, 102, 102, 102]), offB: rss([104, 100, 104, 100, 104]) })
  expect(verdict.result).toBe("INCONCLUSIVE")
})
