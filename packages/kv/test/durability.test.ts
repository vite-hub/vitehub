import { expect, it } from "vitest"

import { kvDurability } from "../src/durability.ts"

it("reports fs-lite stores as host state and hosted stores as shared", () => {
  expect(kvDurability({ stores: { default: { base: ".vitehub/data/kv", driver: "fs-lite" }, sessions: { driver: "upstash" } } })).toMatchObject([
    { primitive: "kv", store: "fs-lite", scope: "host", reason: "Files in .vitehub/data/kv on this host." },
    { primitive: "kv", name: "sessions", store: "upstash", scope: "shared" },
  ])
})
