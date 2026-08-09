import { describe, expect, it } from "vitest"

import { getRealtimePeople } from "../src/presence.ts"

describe("realtime presence", () => {
  it("keeps each active client when they share an identity", () => {
    const identity = { color: "#2563EB", id: "user-1", name: "Maxi" }

    expect(getRealtimePeople(new Map([
      [11, { user: identity }],
      [22, { user: identity }],
    ]))).toEqual([
      { ...identity, clientId: 11 },
      { ...identity, clientId: 22 },
    ])
  })
})
