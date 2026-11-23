import { expect, it } from "vitest"

import { chunkGrowth } from "../scripts/console-weight/chunk-growth.mjs"

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
