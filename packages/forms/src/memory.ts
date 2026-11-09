import type { FormsStore, FormSubmission } from "./types.ts"

/** Submissions in memory, for tests and for a dev server without a Database. They go away when the process stops. */
export function createMemoryFormsStore(): FormsStore {
  const rows = new Map<string, FormSubmission>()
  const copy = (submission: FormSubmission): FormSubmission => structuredClone(submission)
  return {
    async insert(submission) {
      rows.set(submission.id, copy(submission))
    },
    async list(options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
      const { before } = options
      return [...rows.values()]
        .filter(row => !options.form || row.form === options.form)
        .filter(row => !options.status || row.status === options.status)
        .filter(row => !before || row.createdAt < before.createdAt || (row.createdAt === before.createdAt && row.id < before.id))
        .sort((left, right) => right.createdAt - left.createdAt || (right.id > left.id ? 1 : -1))
        .slice(0, limit)
        .map(copy)
    },
    async get(id) {
      const row = rows.get(id)
      return row ? copy(row) : undefined
    },
    async setStatus(id, status, now) {
      const row = rows.get(id)
      if (!row) return undefined
      row.status = status
      row.updatedAt = now
      return copy(row)
    },
  }
}
