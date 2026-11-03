import { afterEach, describe, expect, it } from "vitest"

import {
  consoleBlobKey,
  consoleBlobRegistryKey,
  consoleBlobRootKey,
  installConsoleBlobScope,
  resolveConsoleBlob,
} from "../src/console/internal.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"

// SAFETY: ConsoleInvocationScope only adds optional symbol-keyed test state to the global object.
const scope = globalThis as ConsoleInvocationScope

// The listing, limits, and folders of the Blob page are the `blob.*` operations. They are tested in @vite-hub/blob.
// The Console keeps the project's storage for media and attachments.
// SAFETY: The registry stores the object and never calls it. Identity is what the test checks.
const storageOf = () => ({}) as BlobStorage

afterEach(() => {
  delete scope[consoleBlobKey]
  delete scope[consoleBlobRootKey]
  Reflect.deleteProperty(process, consoleBlobKey)
  Reflect.deleteProperty(process, consoleBlobRootKey)
  Reflect.deleteProperty(process, consoleBlobRegistryKey)
})

describe("Console Blob storage", () => {
  it("isolates concurrent project stores across runtime realms", () => {
    const first = storageOf()
    const second = storageOf()
    const processRegistry = {}
    const firstScope: ConsoleInvocationScope = { process: processRegistry }
    const secondScope: ConsoleInvocationScope = { process: processRegistry }

    installConsoleBlobScope("/first", { storage: first, stores: ["default"] }, firstScope)
    installConsoleBlobScope("/second", { storage: second, stores: ["default"] }, secondScope)

    expect(resolveConsoleBlob(firstScope)?.storage).toBe(first)
    expect(resolveConsoleBlob(secondScope)?.storage).toBe(second)
    expect(resolveConsoleBlob({ process: processRegistry })).toBeUndefined()
  })
})
