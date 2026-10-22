import { computed, ref } from "vue"

import { consoleErrorMessage } from "./documents"

import type { ComputedRef, Ref } from "vue"
import type { ConsoleMediaClient, ConsoleMediaUploadResult } from "./media-library"

export type ConsoleMediaUploadState = "queued" | "uploading" | "done" | "failed"

/** One file in the upload queue. */
export interface ConsoleMediaUploadEntry {
  error?: string
  file: File
  folder: string
  id: number
  /** From 0 to 1 while uploading. */
  progress: number
  result?: ConsoleMediaUploadResult
  state: ConsoleMediaUploadState
}

export interface ConsoleMediaUploads {
  /** Queue files for `folder`. Resolves with the results in order once each file settles; failed files are left out. */
  add(files: readonly File[], folder: string): Promise<ConsoleMediaUploadResult[]>
  /** Done and failed entries leave the queue. */
  clear(): void
  dismiss(id: number): void
  entries: Ref<ConsoleMediaUploadEntry[]>
  /** Files that are queued or uploading. */
  pending: ComputedRef<number>
  /** Upload a failed file again. */
  retry(id: number): Promise<ConsoleMediaUploadResult | undefined>
}

/** Uploads at most this many files at once, so a large drop does not stall the server or the browser. */
const concurrency = 3
let nextId = 0

/**
 * The upload queue of the media library: files upload a few at a time with progress, failures stay in the queue with
 * their reason and a retry, and `add()` resolves with what was stored.
 */
export function useConsoleMediaUploads(client: () => ConsoleMediaClient, onUploaded?: (result: ConsoleMediaUploadResult) => void): ConsoleMediaUploads {
  const entries = ref<ConsoleMediaUploadEntry[]>([])
  const waiting: Array<() => void> = []
  let active = 0

  function patch(id: number, fields: Partial<ConsoleMediaUploadEntry>): void {
    entries.value = entries.value.map(entry => (entry.id === id ? { ...entry, ...fields } : entry))
  }

  async function slot(): Promise<void> {
    if (active < concurrency) {
      active++
      return
    }
    await new Promise<void>(resolve => waiting.push(resolve))
    active++
  }

  function release(): void {
    active--
    waiting.shift()?.()
  }

  async function run(entry: ConsoleMediaUploadEntry): Promise<ConsoleMediaUploadResult | undefined> {
    await slot()
    patch(entry.id, { error: undefined, progress: 0, state: "uploading" })
    try {
      const result = await client().upload(entry.file, { folder: entry.folder, onProgress: progress => patch(entry.id, { progress }) })
      patch(entry.id, { progress: 1, result, state: "done" })
      onUploaded?.(result)
      return result
    }
    catch (error) {
      patch(entry.id, { error: consoleErrorMessage(error, "The upload failed."), state: "failed" })
      return undefined
    }
    finally {
      release()
    }
  }

  return {
    async add(files, folder) {
      const added = files.map((file): ConsoleMediaUploadEntry => ({ file, folder, id: ++nextId, progress: 0, state: "queued" }))
      entries.value = [...entries.value.filter(entry => entry.state !== "done"), ...added]
      const results = await Promise.all(added.map(run))
      return results.filter(result => result !== undefined)
    },
    clear() {
      entries.value = entries.value.filter(entry => entry.state === "queued" || entry.state === "uploading")
    },
    dismiss(id) {
      entries.value = entries.value.filter(entry => entry.id !== id)
    },
    entries,
    pending: computed(() => entries.value.filter(entry => entry.state === "queued" || entry.state === "uploading").length),
    async retry(id) {
      const entry = entries.value.find(candidate => candidate.id === id)
      if (!entry || entry.state !== "failed") return undefined
      patch(id, { state: "queued" })
      return await run(entry)
    },
  }
}
