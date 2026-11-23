import type { Client, createClient, InArgs, InStatement, Transaction, TransactionMode } from "@libsql/client"
import { vi } from "vitest"

import { STATE_DATABASE_NOW } from "../../src/internal/state-database-clock.ts"

function followFakeClock(statement: InStatement): InStatement {
  if (!vi.isFakeTimers() && !vi.isMockFunction(Date.now)) return statement
  const sql = typeof statement === "string" ? statement : statement.sql
  if (!sql.includes(STATE_DATABASE_NOW)) return statement
  const faked = sql.replaceAll(STATE_DATABASE_NOW, String(Date.now()))
  return typeof statement === "string" ? faked : { ...statement, sql: faked }
}

function followFakeClockTransaction(transaction: Transaction): Transaction {
  const execute = transaction.execute.bind(transaction)
  transaction.execute = statement => execute(followFakeClock(statement))
  return transaction
}

export function followFakeClockClient(create: typeof createClient): typeof createClient {
  return (config) => {
    const client: Client = create(config)
    const execute = client.execute.bind(client)
    const transaction = client.transaction.bind(client)
    client.execute = (statement: InStatement, args?: InArgs) => {
      const followed = followFakeClock(statement)
      return typeof followed === "string" ? execute(followed, args) : execute(followed)
    }
    client.transaction = async (mode?: TransactionMode) => followFakeClockTransaction(await transaction(mode))
    return client
  }
}
