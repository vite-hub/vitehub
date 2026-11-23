/** The environment variable that names this server instance. */
export const instanceIdEnv = "VITEHUB_INSTANCE_ID"

const generatedKey = Symbol.for("vitehub.runtime.instance-id")

function generatedInstanceId(): string {
  let host = ""
  try {
    host = globalThis.process?.getBuiltinModule?.("node:os")?.hostname() ?? ""
  }
  catch {}
  const pid = globalThis.process?.pid
  const suffix = globalThis.crypto.randomUUID().slice(0, 8)
  return [host, pid, suffix].filter(part => part !== undefined && part !== "").join(":")
}

/**
 * The owner label of this server instance: `VITEHUB_INSTANCE_ID` when it is set, else `<hostname>:<pid>:<random>`, made
 * once for each process. Leases record it as their `owner`, and Agent Invocation claims start with it, so you can see
 * which instance holds a key or runs an Invocation. Give each instance its own value, such as the pod or machine name.
 */
export function getInstanceId(): string {
  const configured = globalThis.process?.env?.[instanceIdEnv]?.trim()
  if (configured) return configured
  const state = globalThis as typeof globalThis & { [generatedKey]?: string }
  return state[generatedKey] ??= generatedInstanceId()
}
