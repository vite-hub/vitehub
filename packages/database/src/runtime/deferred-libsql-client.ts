import type { Client, InArgs, InStatement, TransactionMode } from "@libsql/client"

/**
 * A libSQL client that loads its driver on the first query. A Worker that uses only D1 then does not load
 * `@libsql/client` at startup. `protocol` is what the loaded client will report. `close()` and `reconnect()` follow
 * libSQL: `close()` closes the client when it is loaded, and `reconnect()` opens it again.
 */
export function deferLibsqlClient(protocol: string, open: () => Promise<Client>): Client {
  let opening: Promise<Client> | undefined
  let opened: Client | undefined
  let closed = false

  // A client that loads after close() is closed too, so a call gets the error of a closed libSQL client.
  function closeIfClosed(value: Client) {
    if (closed && !value.closed) value.close()
    return value
  }

  // A failed load lets the next call try again.
  async function client() {
    return closeIfClosed(await (opening ??= open().then(value => (opened = value)).catch((error: unknown) => {
      opening = undefined
      throw error
    })))
  }

  return {
    batch: async (statements: Array<InStatement | [string, InArgs?]>, mode?: TransactionMode) => (await client()).batch(statements, mode),
    close() {
      closed = true
      void opening?.then(closeIfClosed, () => undefined)
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
    // libSQL clients reconnect asynchronously, so this returns the loaded client's promise for a caller to await.
    reconnect() {
      closed = false
      return opened?.reconnect()
    },
    sync: async () => (await client()).sync(),
    transaction: async (mode?: TransactionMode) => (await client()).transaction(mode),
  }
}
