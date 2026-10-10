import { describe, expect, it } from "vitest"

import {
  applyConsoleColorScheme,
  parseConsoleAppearance,
  readConsoleAppearance,
  rememberConsoleAppearance,
  resolveConsoleColorScheme,
  startConsoleAppearance,
} from "../src/console/runtime/client/appearance.ts"

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set("vitehub-console:appearance", initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    values,
  }
}

function classRoot() {
  const classes = new Set<string>()
  return {
    classes,
    classList: {
      toggle: (token: string, force?: boolean) => {
        if (force ?? !classes.has(token)) classes.add(token)
        else classes.delete(token)
        return classes.has(token)
      },
    },
  }
}

function systemQuery(matches: boolean) {
  const listeners = new Set<() => void>()
  return {
    matches,
    addEventListener: (_type: "change", listener: () => void) => {
      listeners.add(listener)
    },
    change(next: boolean) {
      this.matches = next
      for (const listener of listeners) listener()
    },
  }
}

describe("Console appearance", () => {
  it("follows the system for missing or unknown stored values", () => {
    expect(parseConsoleAppearance("light")).toBe("light")
    expect(parseConsoleAppearance("dark")).toBe("dark")
    expect(parseConsoleAppearance("system")).toBe("system")
    expect(parseConsoleAppearance("Dark")).toBe("system")
    expect(parseConsoleAppearance(null)).toBe("system")
    expect(parseConsoleAppearance(undefined)).toBe("system")
  })

  it("resolves an explicit choice before the system scheme", () => {
    expect(resolveConsoleColorScheme("system", true)).toBe("dark")
    expect(resolveConsoleColorScheme("system", false)).toBe("light")
    expect(resolveConsoleColorScheme("light", true)).toBe("light")
    expect(resolveConsoleColorScheme("dark", false)).toBe("dark")
  })

  it("sets exactly one scheme class so the choice overrides the media query fallback", () => {
    const root = classRoot()
    applyConsoleColorScheme(root, "dark")
    expect([...root.classes]).toEqual(["dark"])
    applyConsoleColorScheme(root, "light")
    expect([...root.classes]).toEqual(["light"])
  })

  it("uses one explicit theme-color tag and restores media queries for System", () => {
    const metas = [
      { dataset: { vitehubConsoleTheme: "light" }, media: "(prefers-color-scheme: light)" },
      { dataset: { vitehubConsoleTheme: "dark" }, media: "(prefers-color-scheme: dark)" },
    ]
    const document = { querySelectorAll: () => metas }

    const query = systemQuery(false)
    const appearance = startConsoleAppearance({
      root: classRoot(), query, storage: memoryStorage("dark"), themeColorDocument: document,
    })
    expect(metas.map(meta => meta.media)).toEqual(["not all", ""])
    query.change(true)
    appearance.select("light")
    expect(metas.map(meta => meta.media)).toEqual(["", "not all"])
    query.change(false)
    query.change(true)
    expect(metas.map(meta => meta.media)).toEqual(["", "not all"])
    appearance.select("system")
    expect(metas.map(meta => meta.media)).toEqual(["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"])
  })

  it("stores the choice and keeps working when storage is unavailable", () => {
    const storage = memoryStorage()
    expect(readConsoleAppearance(storage)).toBe("system")
    rememberConsoleAppearance("dark", storage)
    expect(readConsoleAppearance(storage)).toBe("dark")

    const blocked = {
      getItem: () => { throw new Error("Storage disabled") },
      setItem: () => { throw new Error("Storage disabled") },
    }
    expect(readConsoleAppearance(blocked)).toBe("system")
    expect(() => rememberConsoleAppearance("light", blocked)).not.toThrow()
  })

  it("applies the stored choice at startup and follows the system only for System", () => {
    const root = classRoot()
    const query = systemQuery(true)
    const storage = memoryStorage("light")
    const appearance = startConsoleAppearance({ query, root, storage })

    expect(appearance.preference.value).toBe("light")
    expect([...root.classes]).toEqual(["light"])
    query.change(false)
    query.change(true)
    expect([...root.classes]).toEqual(["light"])

    appearance.select("system")
    expect(storage.values.get("vitehub-console:appearance")).toBe("system")
    expect([...root.classes]).toEqual(["dark"])
    query.change(false)
    expect([...root.classes]).toEqual(["light"])

    appearance.select("dark")
    expect(appearance.preference.value).toBe("dark")
    expect([...root.classes]).toEqual(["dark"])
  })
})
