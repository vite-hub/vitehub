import { expect, it, vi } from "vitest"

import { createSource } from "../src/core/reader.ts"

it.each(["revision", "prepare"] as const)("retries failed %s initialization while sharing concurrent work", async (stage) => {
  const failure = new Error("Temporarily unavailable")
  const revision = { id: "pinned", immutable: true }
  const resolveRevision = vi.fn(async () => revision)
  const prepare = vi.fn(async () => {})
  if (stage === "revision") resolveRevision.mockRejectedValueOnce(failure)
  else prepare.mockRejectedValueOnce(failure)
  const reader = createSource({
    name: "retryable",
    resolveRevision,
    prepare,
    async getKeys() { return ["item"] },
    async getItem(key: string) { return { key, content: "ok" } },
  })

  const first = await Promise.allSettled([reader.keys(), reader.get("item")])
  expect(first).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }])
  await expect(Promise.all([reader.keys(), reader.get("item")])).resolves.toEqual([["item"], { key: "item", content: "ok" }])
  await expect(reader.revision()).resolves.toBe(revision)
  await reader.keys()
  expect(resolveRevision).toHaveBeenCalledTimes(stage === "revision" ? 2 : 1)
  expect(prepare).toHaveBeenCalledTimes(stage === "prepare" ? 2 : 1)
})
