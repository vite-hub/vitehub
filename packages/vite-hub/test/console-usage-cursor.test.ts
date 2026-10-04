import { describe, expect, it } from "vitest"

import { usageCursor, usageQueryWindow } from "../src/console/runtime/server/usage.ts"

describe("Console usage cursors", () => {
  it("rejects non-URL-safe encodings while accepting generated cursors", () => {
    const options = { agentName: "chat", now: "2026-08-27T12:00:00.000Z", window: "24h" as const }
    const to = "2026-08-27T12:00:00.000Z"
    const cursor = usageCursor(options, to, { at: to, id: "run" })

    expect(usageQueryWindow({ ...options, cursor }).after).toMatchObject({ at: to, id: "run" })
    expect(() => usageQueryWindow({ ...options, cursor: `${cursor}==` })).toThrow()
    expect(() => usageQueryWindow({ ...options, cursor: ` ${cursor}` })).toThrow()
  })

  it.each(["r", "run"])("rejects non-zero unused pad bits for id %s", (id) => {
    const options = { agentName: "chat", now: "2026-08-27T12:00:00.000Z", window: "24h" as const }
    const to = options.now
    const cursor = usageCursor(options, to, { at: to, id })
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const last = alphabet.indexOf(cursor.at(-1)!)
    const malformed = cursor.slice(0, -1) + alphabet[last + 1]

    expect([2, 3]).toContain(cursor.length % 4)
    expect(atob(malformed)).toBe(atob(cursor))
    expect(usageQueryWindow({ ...options, cursor }).after).toMatchObject({ at: to, id })
    expect(() => usageQueryWindow({ ...options, cursor: malformed })).toThrow("Invalid usage cursor")
  })
})
