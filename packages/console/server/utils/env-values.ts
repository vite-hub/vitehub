import { useDatabase } from "vite-hub/database"

import { consoleEnvValues, envNamePattern, envStagePattern, envValuesOffMessage, maxEnvValueLength, readConsoleEnvConfig, rotateConsoleEnvValues } from "../../src/env-values.ts"
import { consoleJson, consoleProblem, projectIdOf, projectNotFound } from "./console.ts"

import type { EnvActivity, EnvActor } from "vite-hub/env/bridge"
import type { DatabaseEnvStore, EnvDatabase } from "vite-hub/env/database"
import type { ConsoleTeamCaller } from "./console.ts"

/** Owners and admins write and reveal values. Members see the names and when each one changed. */
function canUseValues(caller: ConsoleTeamCaller): boolean {
  return caller.roles.includes("owner") || caller.roles.includes("admin")
}

/**
 * Who the activity names. A session is the person. An API key is the key, and `target` is the person that it acts for,
 * so a revoked key still says whose it was.
 */
function actorOf(caller: ConsoleTeamCaller): { actor: EnvActor, target?: EnvActor } {
  const key: unknown = Reflect.get(caller, "key")
  const keyId: unknown = key instanceof Object ? Reflect.get(key, "id") : undefined
  if (typeof keyId === "string") return { actor: { id: `api-key:${keyId}`, kind: "agent" }, target: { id: caller.user.id, kind: "user" } }
  return { actor: { id: caller.user.id, kind: "user" } }
}

async function record(store: DatabaseEnvStore, caller: ConsoleTeamCaller, event: Pick<EnvActivity, "action" | "key" | "outcome"> & { revision?: string, operation: string }): Promise<void> {
  const id = crypto.randomUUID()
  await store.access.append({ ...actorOf(caller), ...event, id, operationId: id, timestamp: new Date().toISOString() })
}

let rotation: Promise<void> | undefined

/**
 * With more than one key, the first env request of the process seals every stored value with the current key, so the
 * operator can then remove the previous keys. Reads work during the rotation, because the keyring opens either key. A
 * failed rotation does not fail the request: the next request tries again.
 */
function rotateOnce(db: EnvDatabase, keys: Uint8Array[]): Promise<void> {
  if (keys.length < 2) return Promise.resolve()
  return rotation ??= rotateConsoleEnvValues(db, keys).then(
    ({ namespaces, rotated, skipped }) => console.info(`[vitehub] Env values: sealed ${rotated} values again with the current key, ${skipped} already used it, in ${namespaces} stages.`),
    (error: unknown) => {
      rotation = undefined
      console.error("[vitehub] Env values: the key rotation failed. Values still read with the keyring. Keep the previous keys.", error)
    },
  )
}

const forbidden = () => consoleProblem(403, "CONSOLE_ENV_FORBIDDEN", "Only owners and admins of the team set, delete, and reveal env values. Members see the names.")

function field(body: unknown, name: string): unknown {
  return body instanceof Object ? Reflect.get(body, name) : undefined
}

/**
 * The env values of a project, under `/api/projects/<id>/env`:
 *
 * - `GET /env`: the stages.
 * - `GET /env/<stage>`: the names and when each changed. Never the values.
 * - `PUT /env/<stage>/<NAME>` with `{ "value": "..." }`: set or replace a value. Owners and admins.
 * - `DELETE /env/<stage>/<NAME>`: delete a value. Owners and admins.
 * - `POST /env/<stage>/reveal` with `{ "names": ["NAME"] }`, or `{}` for every value: the values. Owners and admins.
 * - `GET /env/<stage>/<NAME>/activity`: the writes and reveals of a name. Owners and admins.
 *
 * Every write and reveal goes in the env activity first. The activity never holds a value.
 */
export async function consoleEnvRoute(request: Request, caller: ConsoleTeamCaller, env: Record<string, string | undefined> = process.env): Promise<Response> {
  const config = readConsoleEnvConfig(env)
  if (config.state === "off") return consoleProblem(404, "CONSOLE_ENV_VALUES_OFF", envValuesOffMessage)
  if (config.state === "misconfigured") return consoleProblem(500, "CONSOLE_ENV_KEY_INVALID", config.problem)
  const projectId = projectIdOf(request, "/api/projects/")
  if (!await caller.projects.get(projectId)) return projectNotFound()
  const path = new URL(request.url).pathname
  const rest = path.slice(path.indexOf("/env") + "/env".length).split("/").filter(Boolean).map(decodeURIComponent)
  // SAFETY: Drizzle's SQLite databases (libSQL, D1) run `run(sql)` and `all(sql)`, the methods of `EnvDatabase`.
  const db = useDatabase("default").db as unknown as EnvDatabase
  await rotateOnce(db, config.keys)
  const values = consoleEnvValues(db, config.keys, projectId)
  const method = request.method.toUpperCase()

  if (!rest.length && method === "GET") return consoleJson({ stages: await values.stages() })
  const [stage, name, action, ...extra] = rest
  if (!stage || !envStagePattern.test(stage)) return consoleProblem(400, "CONSOLE_ENV_STAGE_INVALID", "A stage is lowercase letters, digits, `-`, and `_`, such as `production` or `staging`.")
  const store = values.stage(stage)

  if (!name && method === "GET") {
    const stages = await values.stages()
    const variables = (await store.list()).map(item => ({ name: item.key, updatedAt: item.updatedAt }))
    return consoleJson({ canReveal: canUseValues(caller), stage, stages: stages.includes(stage) ? stages : [...stages, stage], variables })
  }

  if (name === "reveal" && !action && method === "POST") {
    if (!canUseValues(caller)) return forbidden()
    const body: unknown = await request.json().catch(() => ({}))
    const names = field(body, "names")
    if (names !== undefined && !(Array.isArray(names) && names.every(item => typeof item === "string" && envNamePattern.test(item)))) {
      return consoleProblem(400, "CONSOLE_ENV_INVALID_INPUT", "Send { \"names\": [\"API_TOKEN\"] }, or {} for every value of the stage.")
    }
    const wanted: string[] = names ?? (await store.list()).map(item => item.key)
    const revealed: Record<string, string> = {}
    for (const key of wanted) {
      const meta = await store.secrets.inspect(key)
      if (!meta) continue
      // The record comes before the read, so a value never leaves without a row that says who took it.
      await record(store, caller, { action: "resolve", key, operation: "console.reveal", outcome: "succeeded", revision: meta.revision })
      const found = await store.secrets.read(key)
      if (found) revealed[key] = found.value
    }
    return consoleJson({ stage, values: revealed })
  }

  if (!name || !envNamePattern.test(name) || extra.length) return consoleProblem(400, "CONSOLE_ENV_NAME_INVALID", "A name is letters, digits, and `_`, and does not start with a digit, such as `API_TOKEN`.")

  if (action === "activity" && method === "GET") {
    if (!canUseValues(caller)) return forbidden()
    const before = new URL(request.url).searchParams.get("before") ?? undefined
    return consoleJson({ events: await store.access.activity({ key: name, limit: 50, ...(before ? { before } : {}) }) })
  }
  if (action) return consoleProblem(404, "CONSOLE_ENV_ROUTE_NOT_FOUND", "There is no such env route.")

  if (method === "PUT") {
    if (!canUseValues(caller)) return forbidden()
    const value = field(await request.json().catch(() => undefined), "value")
    if (typeof value !== "string" || value.length > maxEnvValueLength) return consoleProblem(400, "CONSOLE_ENV_INVALID_INPUT", `Send { "value": "..." }, at most ${maxEnvValueLength} characters.`)
    const current = await store.secrets.inspect(name)
    const written = await store.secrets.replace({ expectedRevision: current?.revision ?? null, key: name, value }).catch(() => undefined)
    if (!written) return consoleProblem(409, "CONSOLE_ENV_CONFLICT", `Someone changed ${name} at the same time. Try again.`)
    await record(store, caller, { action: "replace", key: name, operation: "console.set", outcome: "succeeded", revision: written.revision })
    return consoleJson({ variable: { name, updatedAt: written.updatedAt } }, current ? 200 : 201)
  }
  if (method === "DELETE") {
    if (!canUseValues(caller)) return forbidden()
    if (!await store.remove(name)) return consoleProblem(404, "CONSOLE_ENV_NOT_FOUND", `${stage} has no ${name}.`)
    await record(store, caller, { action: "remove", key: name, operation: "console.delete", outcome: "succeeded" })
    return new Response(null, { status: 204 })
  }
  return consoleProblem(405, "CONSOLE_ENV_METHOD", "Use GET, PUT, DELETE, or POST .../reveal.")
}
