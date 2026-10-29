import * as v from "valibot"
import type { EnvSecretStore } from "@vite-hub/env/bridge"

const hostIdentity = v.pipe(v.string(), v.regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const key = "connections-host/chatgpt"

/** One durable Connections store is one host. Transfers never replace this record. */
export async function chatgptHostId(secrets: EnvSecretStore): Promise<string> {
  const current = await secrets.read(key)
  if (current) return v.parse(hostIdentity, current.value)
  const identity = `urn:uuid:${crypto.randomUUID()}`
  try {
    await secrets.replace({ key, value: identity, expectedRevision: null })
    return identity
  }
  catch (error) {
    const winner = await secrets.read(key)
    if (!winner) throw error
    return v.parse(hostIdentity, winner.value)
  }
}
