import { describe, expect, it } from "vitest"

import { createRealtimeIdentity, getRealtimePeople } from "../src/presence.ts"

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

  it("rejects non-string user ids at the public identity boundary", () => {
    expect(() => Reflect.apply(createRealtimeIdentity, undefined, [{ id: 42 }])).toThrow("valid user id")
  })

  it("returns only public identity fields from untrusted presence state", () => {
    const identity = {
      color: "#2563EB",
      id: "user-1",
      name: "Maxi",
      token: "private-token",
    }

    expect(getRealtimePeople(new Map([[11, { user: identity }]]))).toEqual([
      { color: "#2563EB", id: "user-1", name: "Maxi", clientId: 11 },
    ])
  })
})
