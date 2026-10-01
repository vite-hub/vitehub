import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'

import type { SqliteAgentStateExtension, SqliteAgentStateExtensionExecutor, SqliteAgentStateRow } from '../../state/sqlite.ts'

export type PullRequestInboxRow = SqliteAgentStateRow
export type PullRequestInboxExecutor = SqliteAgentStateExtensionExecutor

/**
 * SQL access for the PR inbox. `agentState.extension("babysitter")` from
 * `@vite-hub/agent/state/sqlite` satisfies it and keeps the inbox in the Agent State database.
 */
export interface PullRequestInboxStorage extends Pick<SqliteAgentStateExtension, 'execute' | 'tablePrefix' | 'transaction'> {
  close?: () => Promise<void>
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && ('errcode' in error && (error.errcode === 5 || error.errcode === 6) || /database is (?:locked|busy)/i.test(error.message))
}

/** A private `node:sqlite` file for hosts without Agent State. `:memory:` is accepted for tests. */
export function createNodeSqliteInboxStorage(path: string): PullRequestInboxStorage {
  let database: import('node:sqlite').DatabaseSync | undefined
  let closed = false
  let tail: Promise<void> = Promise.resolve()
  const open = async () => {
    if (database) return database
    const { DatabaseSync } = await import('node:sqlite')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    database = new DatabaseSync(path)
    // A synchronous busy wait would block the event loop while another handle in this
    // process holds the write lock, so BEGIN retries asynchronously instead.
    database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;')
    return database
  }
  const serialize = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = tail
    let release!: () => void
    tail = new Promise(resolve => { release = resolve })
    await previous
    try { return await run() }
    finally { release() }
  }
  const runStatement = async (statement: string, args: unknown[] = []): Promise<PullRequestInboxRow[]> => {
    const db = await open()
    const prepared = db.prepare(statement)
    // SAFETY: inbox statements bind only strings, numbers, and null.
    const values = args as SQLInputValue[]
    if (/^\s*(?:select|with|pragma)\b|\breturning\b/i.test(statement)) return prepared.all(...values)
    prepared.run(...values)
    return []
  }
  return {
    tablePrefix: 'vitehub_babysitter_',
    // One connection: a read must not observe another caller's open transaction.
    execute: async (sql, args) => {
      if (closed) throw new Error('Inbox storage is closed.')
      return await serialize(async () => await runStatement(sql, args))
    },
    transaction: async run => {
      if (closed) throw new Error('Inbox storage is closed.')
      return await serialize(async () => {
      const db = await open()
      for (let delay = 1, waited = 0; ; delay = Math.min(delay * 2, 50)) {
        try {
          db.exec('BEGIN IMMEDIATE')
          break
        }
        catch (error) {
          if (!isBusy(error) || waited >= 10_000) throw error
          waited += delay
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      try {
        const result = await run({ execute: runStatement })
        db.exec('COMMIT')
        return result
      }
      catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      })
    },
    async close() {
      closed = true
      await tail
      database?.close()
      database = undefined
    },
  }
}
