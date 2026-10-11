import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { files } from "../src/loaders/files.ts"
import { json } from "../src/loaders/json.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

describe("cross realm loader content", () => {
  it("writes byte content from another realm through files and json loaders", async () => {
    const bytes = runInNewContext("Uint8Array.of(65, 66)") as Uint8Array
    const store = createMemoryWorkspaceStore()
    await files().load({
      workspace: "probe",
      rootDir: ".",
      sources: [{ key: "source", getKeys: async () => ["hello.txt"], getItem: async () => ({ key: "hello.txt", content: "source" }) } as never],
      store,
      parseData: async input => input.data,
      generateDigest: input => JSON.stringify(input),
      logger: console,
    })
    await files({ transform: () => bytes }).load({
      workspace: "probe",
      rootDir: ".",
      sources: [{ key: "source", getKeys: async () => ["hello.txt"], getItem: async () => ({ key: "hello.txt", content: "source" }) } as never],
      store,
      parseData: async input => input.data,
      generateDigest: input => JSON.stringify(input),
      logger: console,
    })
    const file = await store.readFile("hello.txt")
    expect(file?.content).toBeInstanceOf(Uint8Array)
    expect(Array.from(file?.content as Uint8Array)).toEqual(Array.from(bytes))

    await json({ transform: () => bytes }).load({
      workspace: "probe",
      rootDir: ".",
      sources: [{ key: "json", getKeys: async () => ["record.json"], getItem: async () => ({ key: "record.json", data: { fallback: true } }) } as never],
      store,
      parseData: async input => input.data,
      generateDigest: input => JSON.stringify(input),
      logger: console,
    })
    const jsonFile = await store.readFile("record.json")
    expect(Array.from(jsonFile?.content as Uint8Array)).toEqual(Array.from(bytes))
  })
})
