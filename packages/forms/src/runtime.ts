import { clientAddressKey, createClientRateLimit } from "@vite-hub/internal/runtime/client-rate-limit"
import { registerViteHubUserData } from "@vite-hub/internal/runtime/user-data"

import { createDrizzleFormsStore } from "./database.ts"
import { isFormDefinition } from "./define.ts"
import { formsDiagnostics } from "./errors.ts"
import { handleFormRequest } from "./handler.ts"
import { createFormsInbox } from "./inbox.ts"
import { createMemoryFormsStore } from "./memory.ts"
import { formsTableNames } from "./table-names.ts"

import type { FormsDatabase } from "./database.ts"
import type { FormsInbox } from "./inbox.ts"
import type { SharedRateLimit } from "@vite-hub/internal/runtime/client-rate-limit"
import type { FormDefinition, FormEmailMessage, FormServices, FormsStore, FormUser } from "./types.ts"

/**
 * `useDatabase()` of `@vite-hub/database/runtime/registry`, as the generated handler passes it. Without a name it returns
 * the Database that `vitehub database generate` adds the Forms table to: `default`, else the only one.
 */
export type FormsUseDatabase = (name?: string) => { db: FormsDatabase }

/** What the generated route of a ViteHub app passes. Each service is there only when the app has its feature. */
export interface FormsRuntimeOptions {
  /** The default export of each `server/forms/<name>.ts`, by name. */
  forms: Record<string, unknown>
  /** Returns the Database, and the name that the forms use. */
  useDatabase?: FormsUseDatabase
  database?: string
  /**
   * Without `useDatabase`, keep submissions in the memory of this process. The generated handler sets it only on a
   * development server. Without both, a form that stores submissions answers 503.
   */
  memory?: boolean
  /** `email.send` of ViteHub Email. */
  sendEmail?: (message: FormEmailMessage) => Promise<[unknown, unknown]>
  /** The signed-in user of a request. */
  session?: (request: Request) => Promise<FormUser | null>
  /** The Standard Context of a request, from `getStandardContext()`: the client address in `runtime`, and `waitUntil`. */
  context?: (request: Request) => { runtime?: { clientAddress?: string, cloudflare?: object }, waitUntil?: (promise: Promise<unknown>) => void }
  /**
   * `checkRateLimit` of ViteHub Rate Limit. The generated handler passes it when Rate Limit counts in a KV store that
   * every server process shares. Forms then counts each form and address under the Rate Limit name `forms`. Without
   * it, or when the store does not answer, Forms counts in the memory of this process.
   */
  rateLimit?: FormsSharedRateLimit
}

/** The part of `checkRateLimit()` from `vite-hub/rate-limit` that Forms calls. */
export type FormsSharedRateLimit = SharedRateLimit

const installedKey = Symbol.for("vitehub.forms.installed")
const rejectMissingStore = () => Promise.reject(new Error("[vitehub] Forms has no store."))

const emptyFormsStore: FormsStore = {
  insert: rejectMissingStore,
  insertWith: rejectMissingStore,
  list: async () => [],
  get: async () => undefined,
  setStatus: async () => undefined,
  deleteUser: async () => undefined,
}

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

function decodePathSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  }
  catch (error) {
    if (error instanceof URIError) return undefined
    throw error
  }
}

/**
 * The `{ fetch }` route of every form at `<base>_vitehub/forms/<name>`. The generated Nitro handler of a ViteHub
 * app calls it with the forms of `server/forms/` and the services of the app.
 */
export function createFormsHandler(options: FormsRuntimeOptions): { fetch: (request: Request) => Promise<Response>, registerUserData: (app: unknown) => void } {
  const forms = new Map<string, FormDefinition>()
  for (const [name, form] of Object.entries(options.forms)) {
    if (!isFormDefinition(form)) throw formsDiagnostics.FORMS_C0001({ message: `[vitehub] server/forms/${name} must default-export defineForm({ schema }).` })
    forms.set(name, form)
  }
  const { useDatabase } = options
  const store: FormsStore | undefined = useDatabase
    ? createDrizzleFormsStore(() => {
        try {
          return useDatabase(options.database).db
        }
        catch (cause) {
          throw formsDiagnostics.FORMS_DATABASE_MISSING({ database: options.database, cause })
        }
      })
    : options.memory ? createMemoryFormsStore() : undefined
  Reflect.set(globalThis, installedKey, { names: [...forms.keys()].sort(), inbox: createFormsInbox(store ?? emptyFormsStore) } satisfies InstalledForms)
  const { sendEmail, session, context } = options
  const rateLimit = createClientRateLimit({ name: "forms", unavailable: "Forms could not count this message in Rate Limit", ...(options.rateLimit ? { shared: options.rateLimit } : {}) })
  const services = (request: Request): FormServices => {
    const host = context?.(request)
    const address = clientAddressKey(request, host)
    return {
      ...(store ? { store } : {}),
      rateLimit: (_, key, policy) => rateLimit(request, `${key}:${address}`, policy),
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
    registerUserData(app) {
      if (store) registerViteHubUserData(app, { owner: "forms", tables: Object.values(formsTableNames), delete: userId => store.deleteUser(userId) })
    },
    async fetch(request) {
      const segment = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? ""
      const name = decodePathSegment(segment)
      const form = name === undefined ? undefined : forms.get(name)
      if (name === undefined || !form) return new Response(JSON.stringify({ message: `No form is named ${JSON.stringify(name ?? segment)}.` }), { status: 404, headers: { "content-type": "application/json" } })
      return await handleFormRequest(name, form, request, services(request))
    },
  }
}
