import { formsDiagnostics } from "./errors.ts"

import type { FormsStore, FormStatus, FormSubmission, ListFormSubmissionsOptions } from "./types.ts"

type Result<T> = Promise<[Error, undefined] | [undefined, T]>

/** What server code, the Console, and MCP tools do with submissions. Each call returns `[error, data]`. */
export interface FormsInbox {
  /** Newest first. */
  list(options?: ListFormSubmissionsOptions): Result<FormSubmission[]>
  get(id: string): Result<FormSubmission>
  /** Marks a submission `open`, `done`, or `spam`. */
  setStatus(id: string, status: FormStatus): Result<FormSubmission>
}

const statuses: readonly FormStatus[] = ["open", "done", "spam"]

async function attempt<T>(run: () => Promise<T>): Result<T> {
  try {
    return [undefined, await run()]
  }
  catch (error) {
    return [error instanceof Error ? error : new Error(String(error)), undefined]
  }
}

/** The inbox of a store. */
export function createFormsInbox(store: FormsStore, now: () => number = Date.now): FormsInbox {
  const missing = (id: string) => formsDiagnostics.FORMS_R0002({ message: `[vitehub] No form submission has the id ${JSON.stringify(id)}.` })
  return {
    list: options => attempt(() => store.list(options)),
    get: id => attempt(async () => {
      const submission = await store.get(id)
      if (!submission) throw missing(id)
      return submission
    }),
    setStatus: (id, status) => attempt(async () => {
      if (!statuses.includes(status)) throw new TypeError(`[vitehub] A form submission status is open, done, or spam, not ${JSON.stringify(status)}.`)
      const submission = await store.setStatus(id, status, now())
      if (!submission) throw missing(id)
      return submission
    }),
  }
}
