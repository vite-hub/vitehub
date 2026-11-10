import { parseRecordFile, serialiseRecord } from "@diglot/store/runtime"
import { generateMessageId } from "@lingui/message-utils/generateMessageId"

import { compileMessages } from "./catalogs.ts"
import { parseRecordPath, recordPath, recordSegment } from "./record-format.ts"

import type { Messages } from "@lingui/core"
import type { TranslationRecords } from "./record-format.ts"

/** The ref that readers see. Writes go to `draft`, and `publish()` copies them here. */
export const publishedRef = "published"
export const draftRef = "draft"

interface RevisionView {
  list(path: string, options?: { recursive?: boolean }): Promise<ReadonlyArray<{ path: string, type: string }>>
  readFile(path: string, options: { encoding: "utf8" }): Promise<string>
}

interface Revision {
  id: string
}

/** The parts of a Workspace with retained history that i18n uses. `useWorkspaceFiles(name)` returns them. */
export interface TranslationsWorkspace {
  history: {
    head(options: { ref: string }): Promise<Revision | null>
    open(id: string): Promise<RevisionView>
  }
}

/** The parts of a writable Workspace that saving and publishing use. */
export interface WritableTranslationsWorkspace extends TranslationsWorkspace {
  history: TranslationsWorkspace["history"] & {
    commit(options: {
      ref: string
      ifHead: string | null
      changes: { put?: Record<string, string>, delete?: string[] }
      message?: string
    }): Promise<Revision>
  }
}

/** Read the records of every locale in one Workspace revision. A file that is not a record is skipped. */
export async function readRevisionRecords(view: RevisionView, locales: readonly string[]): Promise<Record<string, TranslationRecords>> {
  const result: Record<string, TranslationRecords> = {}
  await Promise.all(locales.map(async (locale) => {
    const records: TranslationRecords = {}
    const entries = await view.list(`${locale}/segments`, { recursive: true })
    await Promise.all(entries.map(async (entry) => {
      const path = entry.type === "file" ? parseRecordPath(entry.path) : undefined
      if (!path || path.locale !== locale) return
      // Store failures reject the revision; malformed record contents only skip this entry.
      const contents = await view.readFile(entry.path, { encoding: "utf8" })
      const record = parseRecordFile(contents, path.hash)
      if (record && recordSegment(record).hash === path.hash) records[generateMessageId(record.source, record.salt)] = record
    }))
    result[locale] = records
  }))
  return result
}

function compile(records: TranslationRecords, only?: ReadonlySet<string>): Messages {
  const selected = only ? Object.fromEntries(Object.entries(records).filter(([id]) => only.has(id))) : records
  return compileMessages(selected)
}

export interface LiveTranslationsOptions {
  /** Opens the Workspace that stores the translations. */
  workspace: () => TranslationsWorkspace | Promise<TranslationsWorkspace>
  locales: readonly string[]
  sourceLocale: string
  /** The translations that the build embedded. Published records override these; messages without a record keep them. */
  snapshot: Readonly<Record<string, Messages>>
  /** IDs of the messages in browser code. The browser catalog route sends only these, or all with `null`. */
  clientIds: readonly string[] | null
  /** Milliseconds between two reads of the `published` head. Defaults to 5000. */
  interval?: number
  onError?: (error: unknown) => void
}

export interface LiveTranslations {
  /** The published Workspace revision of the catalogs, or `build` for the build snapshot. */
  readonly revision: string
  /** Compiled translations of a locale for the server. */
  messages(locale: string): Messages
  /** Compiled translations of a locale for the browser: only the messages of browser code. */
  clientMessages(locale: string): Messages
  /**
   * Read the `published` head when the last read is older than `interval`. A new revision replaces the catalogs.
   * Calls at the same time share one read. A forced refresh waits for any pending read, then reads again.
   * A failed read keeps the catalogs that the server has.
   */
  refresh(options?: { force?: boolean }): Promise<void>
}

/**
 * Catalogs that follow the `published` ref of a Workspace. Each revision compiles once, so a request after a publish
 * gets the new translations without a deploy.
 */
export function createLiveTranslations(options: LiveTranslationsOptions): LiveTranslations {
  const interval = options.interval ?? 5000
  const clientIds = options.clientIds ? new Set(options.clientIds) : undefined
  const translated = options.locales.filter(locale => locale !== options.sourceLocale)
  let revision = "build"
  let server: Readonly<Record<string, Messages>> = options.snapshot
  let client: Record<string, Messages> = {}
  let checkedAt = Number.NEGATIVE_INFINITY
  let pending: Promise<void> | undefined

  const read = async (): Promise<void> => {
    try {
      const workspace = await options.workspace()
      const head = await workspace.history.head({ ref: publishedRef })
      // Before the first publish, the build snapshot stays.
      if (!head || head.id === revision) return
      const records = await readRevisionRecords(await workspace.history.open(head.id), translated)
      server = Object.fromEntries(translated.map(locale => [locale, { ...options.snapshot[locale], ...compile(records[locale] ?? {}) }]))
      client = Object.fromEntries(translated.map(locale => [locale, compile(records[locale] ?? {}, clientIds)]))
      revision = head.id
    }
    catch (error) {
      options.onError?.(error)
    }
    finally {
      pending = undefined
    }
  }

  return {
    get revision() {
      return revision
    },
    messages: locale => server[locale] ?? {},
    clientMessages(locale) {
      if (revision === "build") {
        const snapshot = server[locale] ?? {}
        return clientIds ? Object.fromEntries(Object.entries(snapshot).filter(([id]) => clientIds.has(id))) : snapshot
      }
      return client[locale] ?? {}
    },
    async refresh(refreshOptions) {
      if (pending && refreshOptions?.force) await pending
      // Forced calls waiting on the same read can share the next read.
      if (pending) return pending
      const now = Date.now()
      if (!refreshOptions?.force && now - checkedAt < interval) return Promise.resolve()
      checkedAt = now
      return pending = read()
    },
  }
}

/** Files to put on `published` so that it has every draft record. Records that are equal stay out. */
export function recordChanges(draft: Record<string, TranslationRecords>, published: Record<string, TranslationRecords>): Record<string, string> {
  const put: Record<string, string> = {}
  for (const [locale, records] of Object.entries(draft)) {
    for (const [id, record] of Object.entries(records)) {
      const current = published[locale]?.[id]
      if (current && JSON.stringify(current) === JSON.stringify(record)) continue
      put[recordPath(locale, record.hash)] = serialiseRecord(record)
    }
  }
  return put
}
