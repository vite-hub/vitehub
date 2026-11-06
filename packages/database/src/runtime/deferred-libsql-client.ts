import type { Client, InArgs, InStatement, TransactionMode } from "@libsql/client"

/**
 * A libSQL client that loads its driver on the first query. A Worker that uses only D1 then does not load
 * `@libsql/client` at startup. `protocol` is what the loaded client will report. `close()` stays synchronous, as in
 * libSQL: it closes the client when it is loaded.
 */
export function deferLibsqlClient(protocol: string, open: () => Promise<Client>): Client {
  let opening: Promise<Client> | undefined
  let opened: Client | undefined
  let closed = false

  async function client() {
    const value = await (opening ??= open().then(value => (opened = value)))
    // A call after close() gets the error of a closed libSQL client.
    if (closed && !value.closed) value.close()
    return value
  }

  return {
    batch: async (statements: Array<InStatement | [string, InArgs?]>, mode?: TransactionMode) => (await client()).batch(statements, mode),
    close() {
      closed = true
      void opening?.then(value => value.closed || value.close(), () => undefined)
    },
    get closed() {
      return closed || (opened?.closed ?? false)
    },
    execute: async (statement: InStatement | string, args?: InArgs) => {
      const value = await client()
      return typeof statement === "string" ? value.execute(statement, args) : value.execute(statement)
    },
    executeMultiple: async (sql: string) => (await client()).executeMultiple(sql),
    migrate: async (statements: InStatement[]) => (await client()).migrate(statements),
    get protocol() {
      return opened?.protocol ?? protocol
    },
    reconnect() {
      opened?.reconnect()
    },
    sync: async () => (await client()).sync(),
    transaction: async (mode?: TransactionMode) => (await client()).transaction(mode),
  }
}
