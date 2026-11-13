import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { messageSegment, recordPath, saveTranslation } from "../src/records.ts"
import { hubI18n } from "../src/vite.ts"

const recordIO = vi.hoisted(() => ({
  active: 0,
  maximum: 0,
  pause: undefined as undefined | (() => Promise<void>),
}))

vi.mock("../src/records.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/records.ts")>()
  return {
    ...actual,
    readRecords: async (...args: Parameters<typeof actual.readRecords>) => {
      const pause = recordIO.pause
      recordIO.pause = undefined
      recordIO.maximum = Math.max(recordIO.maximum, ++recordIO.active)
      try {
        const result = await actual.readRecords(...args)
        await pause?.()
        return result
      }
      finally {
        recordIO.active--
      }
    },
  }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => resolve = done)
  return { promise, resolve }
}

function hook<T>(value: T | { handler: T }): T {
  return value && typeof value === "object" && "handler" in value ? value.handler : value as T
}

describe("record changes in development", () => {
  it("serializes catalog regeneration when record changes overlap", async () => {
    const root = await mkdtemp(join(tmpdir(), "i18n-dev-records-"))
    const release = deferred()
    const pending: Promise<unknown>[] = []
    try {
      const records = join(root, "locales")
      const { hash } = messageSegment("Save")
      await saveTranslation(records, "es", { message: "Save" }, "Original", { by: "ana" })
      const plugin = hubI18n({ locales: ["en", "es"], projectRoot: root })
      await hook(plugin.config!).call({} as never, { root }, { command: "serve", mode: "development" } as never)
      let onRecord!: (event: string, file: string) => Promise<void>
      const invalidateModule = vi.fn()
      const send = vi.fn()
      hook(plugin.configureServer!).call({} as never, {
        watcher: { add: vi.fn(), on: (_event: string, listener: typeof onRecord) => { onRecord = listener } },
        environments: { ssr: { moduleGraph: { getModuleById: () => undefined, getModulesByFile: () => ["messages"], invalidateModule }, hot: { send } } },
      } as never)
      const entered = deferred()
      recordIO.maximum = 0
      recordIO.pause = async () => { entered.resolve(); await release.promise }
      await saveTranslation(records, "es", { message: "Save" }, "Older", { by: "ana" })
      pending.push(onRecord("change", join(records, recordPath("es", hash))))
      await entered.promise
      await saveTranslation(records, "es", { message: "Save" }, "Newest", { by: "ana" })
      pending.push(onRecord("change", join(records, recordPath("es", hash))))
      await new Promise<void>(done => setImmediate(done))
      release.resolve()
      await Promise.all(pending)
      expect(recordIO.maximum).toBe(1)
      const generated = await readFile(join(root, ".vitehub/i18n/messages.mjs"), "utf8")
      expect(generated).toContain("Newest")
      expect(generated).not.toContain("Older")
      expect(invalidateModule).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledTimes(2)
    }
    finally {
      release.resolve()
      await Promise.allSettled(pending)
      recordIO.pause = undefined
      await rm(root, { recursive: true, force: true })
    }
  })
})
