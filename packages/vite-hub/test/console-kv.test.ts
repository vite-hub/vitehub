import { afterEach, describe, expect, it } from "vitest"

import {
  consoleKVKey,
  consoleKVRegistryKey,
  consoleKVRootKey,
  installConsoleKVScope,
  resolveConsoleKV,
} from "../src/console/internal.ts"

import type { KVStorage } from "@vite-hub/kv"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"

// SAFETY: ConsoleInvocationScope only adds optional symbol-keyed test state to the global object.
const scope = globalThis as ConsoleInvocationScope

// The listing, values, and writes of the KV page are the `kv.*` operations. They are tested in @vite-hub/kv.
// SAFETY: The registry stores the object and never calls it. Identity is what the test checks.
const storageOf = () => ({}) as KVStorage

afterEach(() => {
  delete scope[consoleKVKey]
  delete scope[consoleKVRootKey]
  Reflect.deleteProperty(process, consoleKVKey)
  Reflect.deleteProperty(process, consoleKVRootKey)
  Reflect.deleteProperty(process, consoleKVRegistryKey)
})

describe("Console KV storage", () => {
  it("isolates concurrent project stores across runtime realms", () => {
    const first = storageOf()
    const second = storageOf()
    const processRegistry = {}
    const firstScope: ConsoleInvocationScope = { process: processRegistry }
    const secondScope: ConsoleInvocationScope = { process: processRegistry }

    installConsoleKVScope("/first", { storage: first, stores: ["default"] }, firstScope)
    installConsoleKVScope("/second", { storage: second, stores: ["default"] }, secondScope)

    expect(resolveConsoleKV(firstScope)?.storage).toBe(first)
    expect(resolveConsoleKV(secondScope)?.storage).toBe(second)
    expect(resolveConsoleKV({ process: processRegistry })).toBeUndefined()
  })
})
