import { describe, expect, it } from "vitest"

import {
  readConsoleAgentListOpen,
  rememberConsoleAgentListOpen,
  resolveConsoleAgentRows,
} from "../src/console/runtime/components/console-agent-list.ts"

const names = ["a", "b", "c", "d", "e", "f", "g"]

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

describe("console Agent list", () => {
  it("shows every Agent up to the limit", () => {
    expect(resolveConsoleAgentRows(names.slice(0, 5), "e", false)).toEqual({ hidden: 0, visible: ["a", "b", "c", "d", "e"] })
  })

  it("shows five Agents and counts the rest", () => {
    expect(resolveConsoleAgentRows(names, "b", false)).toEqual({ hidden: 2, visible: ["a", "b", "c", "d", "e"] })
  })

  it("keeps the selected Agent visible when it is past the limit", () => {
    expect(resolveConsoleAgentRows(names, "g", false)).toEqual({ hidden: 2, visible: ["a", "b", "c", "d", "g"] })
  })

  it("ignores a selected Agent that the host does not list", () => {
    expect(resolveConsoleAgentRows(names, "missing", false)).toEqual({ hidden: 2, visible: ["a", "b", "c", "d", "e"] })
  })

  it("shows every Agent after Show more", () => {
    expect(resolveConsoleAgentRows(names, "g", true)).toEqual({ hidden: 0, visible: names })
  })

  it("remembers whether the list is open", () => {
    const storage = memoryStorage()
    expect(readConsoleAgentListOpen(storage)).toBe(true)
    rememberConsoleAgentListOpen(false, storage)
    expect(readConsoleAgentListOpen(storage)).toBe(false)
    rememberConsoleAgentListOpen(true, storage)
    expect(readConsoleAgentListOpen(storage)).toBe(true)
  })

  it("keeps the list open when storage is unavailable", () => {
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    expect(readConsoleAgentListOpen(blocked)).toBe(true)
    expect(() => rememberConsoleAgentListOpen(false, blocked)).not.toThrow()
  })
})
