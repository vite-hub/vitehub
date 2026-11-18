import * as v from "valibot"

import type { ServerEnvDescriptionEntry } from "@vite-hub/env"

const statusEntrySchema = v.object({
  blocking: v.boolean(),
  conflict: v.optional(v.literal(true)),
  name: v.optional(v.string()),
  names: v.optional(v.array(v.string())),
  path: v.optional(v.string()),
  provider: v.optional(v.string()),
  required: v.boolean(),
  secret: v.boolean(),
  source: v.picklist(["env", "literal", "provider"]),
  status: v.picklist(["available", "defaulted", "error", "invalid", "missing"]),
})

const inspectSchema = v.object({
  entries: v.array(statusEntrySchema),
  host: v.optional(v.string()),
  ok: v.boolean(),
})

/** One entry of `env.inspect`: names and status of a Server Env declaration, never a value. */
export interface ConsoleEnvStatus {
  blocking: boolean
  conflict?: true | undefined
  /** The host variable name that supplied the value. */
  name?: string | undefined
  names?: string[] | undefined
  path?: string | undefined
  provider?: string | undefined
  required: boolean
  secret: boolean
  source: "env" | "literal" | "provider"
  status: "available" | "defaulted" | "error" | "invalid" | "missing"
}

/** The answer of the `env.inspect` operation of Env. */
export interface ConsoleEnvInspect {
  entries: ConsoleEnvStatus[]
  /** The host that the app runs on, such as `cloudflare`. */
  host?: string | undefined
  ok: boolean
}

/** Reads an untrusted `env.inspect` answer. */
export function parseEnvInspect(value: unknown): ConsoleEnvInspect {
  return v.parse(inspectSchema, value)
}

/** Description and inspection use the same registry traversal order, including undisclosed names. */
export function indexEnvStatuses(entries: readonly ServerEnvDescriptionEntry[], statuses: readonly ConsoleEnvStatus[]): ReadonlyMap<ServerEnvDescriptionEntry, ConsoleEnvStatus> {
  return new Map(entries.flatMap((entry, index) => {
    const status = statuses[index]
    return status ? [[entry, status] as const] : []
  }))
}

/** The command that sets the missing host variables from the shell and `.env.<stage>`. */
export function envPushCommand(host: string | undefined): string {
  return host && host !== "node" ? `vitehub env push --host ${host}` : "vitehub env push"
}

/** What to do about the blocking values of an `env.inspect` answer, in Console hint text. Undefined when none block. */
export function envStatusFix(result: ConsoleEnvInspect): { title: string, description: string } | undefined {
  const blocking = result.entries.filter(entry => entry.blocking)
  if (!blocking.length) return undefined
  const missing = blocking.filter(entry => entry.source === "env" && entry.status === "missing")
  const names = missing.map(entry => entry.names?.[0]).filter((name): name is string => Boolean(name))
  const steps: string[] = []
  if (missing.length) {
    const list = names.length ? `${names.map(name => `\`${name}\``).join(", ")} ${names.length === 1 ? "is" : "are"}` : `${missing.length} ${missing.length === 1 ? "value is" : "values are"}`
    steps.push(result.host === "node"
      ? `${list} not set. Set ${missing.length === 1 ? "it" : "them"} in the server environment, then restart the app.`
      : `${list} not set on the host. Run \`${envPushCommand(result.host)}\` to set ${missing.length === 1 ? "it" : "them"} from \`.env.<stage>\`, then deploy again.`)
  }
  const providers = [...new Set(blocking.filter(entry => entry.status === "error").map(entry => entry.provider ?? "the provider"))]
  if (providers.length) steps.push(`${providers.map(provider => `\`${provider}\``).join(", ")} did not answer. Check the provider and its credentials.`)
  const invalid = blocking.filter(entry => entry.status === "invalid").length
  if (invalid) steps.push(`${invalid} ${invalid === 1 ? "value does" : "values do"} not match the declared type. Fix the host value.`)
  const other = blocking.length - missing.length - blocking.filter(entry => entry.status === "error" || entry.status === "invalid").length
  if (other > 0) steps.push(`${other} more ${other === 1 ? "value is" : "values are"} missing. Open a row to see its source.`)
  return {
    title: `${blocking.length} ${blocking.length === 1 ? "value blocks" : "values block"} the app`,
    description: steps.join(" "),
  }
}
