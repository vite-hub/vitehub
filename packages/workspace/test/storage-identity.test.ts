import { describe, expect, it } from "vitest"

import { registerWorkspaceStoreAlias } from "../src/storage/identity.ts"
import { withWorkspaceStoreMutation } from "../src/storage/mutation.ts"

function store() {
  return { getMeta: async () => undefined } as never
}

describe("Workspace Store identities", () => {
  it("merges a reused alias with each overlay it wraps", async () => {
    const alias = store()
    const first = store()
    const second = store()
    const events: string[] = []
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })

    registerWorkspaceStoreAlias(alias, first)
    registerWorkspaceStoreAlias(alias, second)
    const pending = withWorkspaceStoreMutation(first, async () => {
      events.push("first:start")
      await hold
      events.push("first:end")
    })
    const queued = withWorkspaceStoreMutation(alias, async () => {
      events.push("alias")
    })

    await Promise.resolve()
    expect(events).toEqual(["first:start"])
    release()
    await Promise.all([pending, queued])
    expect(events).toEqual(["first:start", "first:end", "alias"])
  })

  it("keeps the queue identity when an existing target is promoted", async () => {
    const alias = store()
    const first = store()
    const promoted = store()
    const events: string[] = []
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })

    registerWorkspaceStoreAlias(alias, first)
    const pending = withWorkspaceStoreMutation(first, async () => {
      events.push("first:start")
      await hold
      events.push("first:end")
    })
    registerWorkspaceStoreAlias(first, promoted)
    const queued = withWorkspaceStoreMutation(promoted, async () => {
      events.push("promoted")
    })

    await Promise.resolve()
    expect(events).toEqual(["first:start"])
    release()
    await Promise.all([pending, queued])
    expect(events).toEqual(["first:start", "first:end", "promoted"])
  })
})
