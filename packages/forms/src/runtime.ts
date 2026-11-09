import { createDrizzleFormsStore } from "./database.ts"
import { isFormDefinition } from "./define.ts"
import { formsDiagnostics } from "./errors.ts"
import { handleFormRequest } from "./handler.ts"
import { createFormsInbox } from "./inbox.ts"
import { createMemoryFormsStore } from "./memory.ts"

import type { FormsDatabase } from "./database.ts"
import type { FormsInbox } from "./inbox.ts"
import type { FormDefinition, FormEmailMessage, FormRateLimit, FormRateLimitDecision, FormServices, FormsStore, FormUser } from "./types.ts"

/** The Database registry of `@vite-hub/database/drizzle`, as the generated handler passes it. */
export type FormsDatabaseRegistry = Record<string, { db: FormsDatabase } | undefined>

/** What the generated route of a ViteHub app passes. Each service is there only when the app has its feature. */
export interface FormsRuntimeOptions {
  /** The default export of each `server/forms/<name>.ts`, by name. */
  forms: Record<string, unknown>
  /** The Database registry, and the name that the forms use. Without it, submissions stay in memory. */
  databases?: FormsDatabaseRegistry
  database?: string
  /** `email.send` of ViteHub Email. */
  sendEmail?: (message: FormEmailMessage) => Promise<[unknown, unknown]>
  /** The signed-in user of a request. */
  session?: (request: Request) => Promise<FormUser | null>
  /** The Standard Context of a request, from `getStandardContext()`: the client address in `runtime`, and `waitUntil`. */
  context?: (request: Request) => { runtime?: { clientAddress?: string }, waitUntil?: (promise: Promise<unknown>) => void }
}

const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function windowMs(window: string): number {
  const [, amount, unit] = /^(\d+)(ms|s|m|h|d)$/.exec(window) ?? []
  return Number(amount) * (units[unit ?? "m"] ?? 60_000)
}

/** A fixed window for each key, in this process only. Enough for one Node server; a Worker should use Rate Limit. */
export function memoryFormRateLimit(now: () => number = Date.now): (key: string, policy: FormRateLimit) => FormRateLimitDecision {
  const windows = new Map<string, { count: number, resetAt: number }>()
  return (key, policy) => {
    const time = now()
    if (windows.size > 10_000) for (const [stale, entry] of windows) if (entry.resetAt <= time) windows.delete(stale)
    const current = windows.get(key)
    const entry = current && current.resetAt > time ? current : { count: 0, resetAt: time + windowMs(policy.window) }
    entry.count += 1
    windows.set(key, entry)
    return entry.count <= policy.limit ? { allowed: true } : { allowed: false, retryAfter: (entry.resetAt - time) / 1000 }
  }
}

/** The Database that `database` names, else `default`, else the only one. */
function selectDatabase(databases: FormsDatabaseRegistry, name?: string): FormsDatabase | undefined {
  if (name) return databases[name]?.db
  if (databases.default) return databases.default.db
  const names = Object.keys(databases)
  return names.length === 1 ? databases[names[0]!]?.db : undefined
}

const installedKey = Symbol.for("vitehub.forms.installed")

/** The forms and inbox of the running app, for the Console and MCP tools. */
export interface InstalledForms {
  names: string[]
  inbox: FormsInbox
}

export function installedForms(): InstalledForms | undefined {
  const value: unknown = Reflect.get(globalThis, installedKey)
  // SAFETY: only createFormsHandler() writes this process slot.
  return value === undefined ? undefined : value as InstalledForms
}

/**
 * The `{ fetch }` route of every form at `<base>api/_vitehub/forms/<name>`. The generated Nitro handler of a ViteHub
 * app calls it with the forms of `server/forms/` and the services of the app.
 */
export function createFormsHandler(options: FormsRuntimeOptions): { fetch: (request: Request) => Promise<Response> } {
  const forms = new Map<string, FormDefinition>()
  for (const [name, form] of Object.entries(options.forms)) {
    if (!isFormDefinition(form)) throw formsDiagnostics.FORMS_C0001({ message: `[vitehub] server/forms/${name} must default-export defineForm({ schema }).` })
    forms.set(name, form)
  }
  const { databases } = options
  const store: FormsStore = databases
    ? createDrizzleFormsStore(() => {
        const db = selectDatabase(databases, options.database)
        if (!db) throw new Error(`[vitehub] Forms has no Database${options.database ? ` named ${JSON.stringify(options.database)}` : ""}.`)
        return db
      })
    : createMemoryFormsStore()
  Reflect.set(globalThis, installedKey, { names: [...forms.keys()].sort(), inbox: createFormsInbox(store) } satisfies InstalledForms)
  const memoryLimit = memoryFormRateLimit()
  const { sendEmail, session, context } = options
  const services = (request: Request): FormServices => {
    const host = context?.(request)
    const address = host?.runtime?.clientAddress ?? request.headers.get("cf-connecting-ip") ?? "unknown"
    return {
      store,
      // Counts in this server process. Rate Limit on Cloudflare needs each limit name at build time.
      rateLimit: async (_, key, policy) => memoryLimit(`${key}:${address}`, policy),
      ...(sendEmail ? { email: async (message: FormEmailMessage) => {
        const [error] = await sendEmail(message)
        if (error) throw error
      } } : {}),
      ...(session ? { identify: session } : {}),
      ...(host?.waitUntil ? { waitUntil: host.waitUntil } : {}),
      log: (message, error) => console.error(message, error ?? ""),
    }
  }
  return {
    async fetch(request) {
      const name = decodeURIComponent(new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "")
      const form = forms.get(name)
      if (!form) return new Response(JSON.stringify({ message: `No form is named ${JSON.stringify(name)}.` }), { status: 404, headers: { "content-type": "application/json" } })
      return await handleFormRequest(name, form, request, services(request))
    },
  }
}
