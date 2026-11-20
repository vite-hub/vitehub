import { useDatabase } from "vite-hub/database"

import { consoleEnvValues, envNamePattern, envStagePattern, envValuesOffMessage, maxEnvValueLength, readConsoleEnvConfig, rotateConsoleEnvValues } from "../../src/env-values.ts"
import { consoleErrorDiagnostics } from "../../src/error-diagnostics.ts"
import { consoleDiagnosticProblem, consoleJson, consoleProblem, projectIdOf, projectNotFound } from "./console.ts"

import type { EnvActivity, EnvActor } from "vite-hub/env/bridge"
import type { DatabaseEnvStore, EnvDatabase } from "vite-hub/env/database"
import type { ConsoleTeamCaller } from "./console.ts"

function canUseValues(caller: ConsoleTeamCaller): boolean {
  return caller.roles.includes("owner") || caller.roles.includes("admin")
}

function actorOf(caller: ConsoleTeamCaller): { actor: EnvActor, target?: EnvActor } {
  const key: unknown = Reflect.get(caller, "key")
  const keyId: unknown = key instanceof Object ? Reflect.get(key, "id") : undefined
  if (typeof keyId === "string") return { actor: { id: `api-key:${keyId}`, kind: "agent" }, target: { id: caller.user.id, kind: "user" } }
  return { actor: { id: caller.user.id, kind: "user" } }
}

type ActivityInput = Pick<EnvActivity, "action" | "key" | "outcome"> & { revision?: string, operation: string, operationId?: string }

async function record(store: DatabaseEnvStore, caller: ConsoleTeamCaller, event: ActivityInput): Promise<void> {
  const id = crypto.randomUUID()
  await store.access.append({ ...actorOf(caller), ...event, id, operationId: event.operationId ?? id, timestamp: new Date().toISOString() })
}

function isSealInvalid(error: unknown): boolean {
  return error instanceof Object && Reflect.get(error, "code") === "SEAL_INVALID"
}

let rotation: Promise<void> | undefined

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
    const reveals: { event: ActivityInput, value?: string }[] = []
    const finish = (outcome: "failed" | "succeeded") => Promise.all(reveals.map(({ event, value }) => record(store, caller, { ...event, outcome: value === undefined ? "failed" : outcome })))
    for (const key of wanted) {
      const meta = await store.secrets.inspect(key)
      if (!meta) continue
      const reveal: { event: ActivityInput, value?: string } = { event: { action: "resolve", key, operation: "console.reveal", operationId: crypto.randomUUID(), outcome: "started", revision: meta.revision } }
      await record(store, caller, reveal.event)
      reveals.push(reveal)
      try {
        reveal.value = (await store.secrets.read(key))?.value
      }
      catch (error) {
        await finish("failed")
        if (isSealInvalid(error)) return consoleDiagnosticProblem(500, consoleErrorDiagnostics.CONSOLE_ENV_KEY_MISSING({ name: key, stage }))
        throw error
      }
    }
    await finish("succeeded")
    const revealed: Record<string, string> = {}
    for (const { event, value } of reveals) if (value !== undefined) revealed[event.key] = value
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
