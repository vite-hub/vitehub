import { runOperation } from "@vite-hub/internal/operations"
import { afterEach, expect, it, vi } from "vitest"

import { consoleDocumentsKey, consoleDocumentsRegistryKey, consoleDocumentsRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey } from "../src/console/internal.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDocuments } from "../src/console/runtime/server/documents.ts"
import { consoleOperationRegistry } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

afterEach(() => {
  for (const key of [consoleDocumentsKey, consoleDocumentsRegistryKey, consoleDocumentsRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey, Symbol.for("vitehub.console.access")]) {
    Reflect.deleteProperty(globalThis, key)
  }
})

it.each([undefined, null, { collection: "posts" }])("preserves an optional document operation body of %s", async (body) => {
  installConsoleAccess({ mode: "open", authorize: () => true })
  installConsoleSections("/app", ["content"])
  const overview = vi.fn(() => ({ total: 0 }))
  const unused = () => { throw new Error("unused") }
  installConsoleDocuments("/app", {
    content: {
      load: async () => ({}),
      actions: () => ({
        collections: () => [],
        mediaAccess: () => ({ manage: false, read: false, write: false }),
        get: unused,
        list: unused,
        overview,
        preview: unused,
        publish: unused,
        raw: unused,
        references: unused,
        remove: unused,
        resolve: unused,
        restore: unused,
        revisions: unused,
        save: unused,
        schedule: unused,
        search: unused,
        session: unused,
        sessions: unused,
        unschedule: unused,
      }),
    },
  })
  const input = { action: "overview", section: "content", ...(body === undefined ? {} : { body }) }
  const result = await runOperation(consoleOperationRegistry(), "documents.action", input, {
    access: { mode: "agent", sections: "all" }, surface: "agent", user: { id: "viewer" },
  })

  expect(result).toEqual({ ok: true, value: { total: 0 } })
  expect(overview).toHaveBeenCalledWith(body, { user: { id: "viewer" } })
})
