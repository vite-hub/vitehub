// The libSQL driver of the default Agent Invocation journal: a local SQLite file or a remote libSQL URL.
// Hosts pass it to `createDefaultAgentInvocations()` from `default-core` only when a build can select libSQL,
// so a Cloudflare Worker that stores the journal in D1 or memory does not ship the libSQL client.
import { createClient } from "@libsql/client"

import { createLibsqlAgentInvocationStore } from "./sqlite.ts"

import type { Client } from "@libsql/client"
import type { AgentInvocationStore } from "../invocations.ts"
import type { AgentRetentionPolicy } from "../retention.ts"

export interface DefaultAgentInvocationsLibsqlLocation {
  authToken?: string
  /** The local journal file. Its directory is created before the client opens it. */
  file?: string
  url: string
}

/** Opens the libSQL client and the store of the default journal. */
export async function openDefaultLibsqlJournal(location: DefaultAgentInvocationsLibsqlLocation, retention: AgentRetentionPolicy | undefined): Promise<{ client: Client, store: Required<AgentInvocationStore> }> {
  const { file, ...config } = location
  if (file) (await import("./default-file.ts")).createJournalDirectory(file)
  const client = createClient(config)
  try {
    return {
      client,
      store: createLibsqlAgentInvocationStore({
        client,
        // Keep invalid values, such as null, so that the store rejects them.
        maxAge: retention?.maxAge === undefined ? false : retention.maxAge,
        maxRecords: retention?.maxRecords === undefined ? false : retention.maxRecords,
        maxSize: retention?.maxSize === undefined ? false : retention.maxSize,
      }),
    }
  }
  catch (error) {
    client.close()
    throw error
  }
}
