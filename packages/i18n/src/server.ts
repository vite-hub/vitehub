import { setupI18n } from "@lingui/core"
import { compileMessage } from "@lingui/message-utils/compileMessage"
import { generateMessageId } from "@lingui/message-utils/generateMessageId"

import { i18nErrorDiagnostics } from "./errors.ts"
import { createLiveTranslations, draftRef, publishedRef, readRevisionRecords, recordChanges } from "./live.ts"
import { recordPath } from "./record-format.ts"
import { configureI18n, resolveRequestLocale, setI18nScope } from "./runtime.ts"

import type { I18n, Messages } from "@lingui/core"
import type { Result } from "@vite-hub/runtime"
import type { LiveTranslations, TranslationsWorkspace, WritableTranslationsWorkspace } from "./live.ts"
import type { TranslationRecord, TranslationRecords, TranslationReview } from "./record-format.ts"
import type { I18nRuntimeConfig } from "./runtime.ts"

export type { TranslationRecord, TranslationRecords, TranslationReview } from "./record-format.ts"
export type { TranslationsWorkspace, WritableTranslationsWorkspace } from "./live.ts"

type HeaderBag = { get(name: string): string | null }

/** The parts of an H3 2 event that the server scope reads. */
interface RequestEvent {
  context?: Record<string, unknown>
  req?: { headers?: HeaderBag } | unknown
}

interface NitroAppLike {
  hooks: { hook(name: "request", callback: (event: RequestEvent) => unknown): unknown }
}

export interface I18nServerWorkspaceOptions {
  /** Name of the Workspace, for errors. */
  name: string
  /** Opens the Workspace. `useWorkspaceFiles(name, { mode })` from `vite-hub/workspace/files`. */
  open: (mode: "read" | "write") => TranslationsWorkspace | WritableTranslationsWorkspace
  /** IDs of the messages in browser code, or `null` when the build did not collect them, as in development. */
  clientIds: readonly string[] | null
  /** Milliseconds between two reads of the `published` head. Defaults to 5000. */
  interval?: number
}

export interface I18nServerOptions {
  config: I18nRuntimeConfig
  /** Compiled translations of every locale from the build. The server loads them all, so a request never waits. */
  messages: Readonly<Record<string, Messages>>
  /** Returns the event or request of the current request from Nitro's async context. */
  current: () => unknown
  /** Read translations from a Workspace, so a published translation is live without a deploy. */
  workspace?: I18nServerWorkspaceOptions
}

interface ServerState {
  options: I18nServerOptions
  live?: LiveTranslations
}

const eventKey = "vitehubI18n"
const stateKey = Symbol.for("vite-hub.i18n.server")

function serverState(): ServerState | undefined {
  return (globalThis as typeof globalThis & { [stateKey]?: ServerState })[stateKey]
}

const noHeaders: HeaderBag = { get: () => null }

function requestHeaders(event: RequestEvent): HeaderBag {
  const headers = (event.req as { headers?: unknown } | undefined)?.headers
  return headers && typeof (headers as HeaderBag).get === "function" ? headers as HeaderBag : noHeaders
}

/**
 * Give each request its own i18n instance. Nitro's async context finds the request that runs a message, so
 * server code calls `t` without passing the event.
 */
export function installI18nServer(nitroApp: NitroAppLike, options: I18nServerOptions): void {
  const workspace = options.workspace
  const live = workspace
    ? createLiveTranslations({
        workspace: () => workspace.open("read"),
        locales: options.config.locales,
        sourceLocale: options.config.sourceLocale,
        snapshot: options.messages,
        clientIds: workspace.clientIds,
        ...(workspace.interval === undefined ? {} : { interval: workspace.interval }),
        onError: error => console.error(`[vitehub] i18n could not read the Workspace ${JSON.stringify(workspace.name)}. The server keeps its translations.`, error),
      })
    : undefined
  ;(globalThis as typeof globalThis & { [stateKey]?: ServerState })[stateKey] = { options, live }
  const messagesOf = (locale: string): Messages => live ? live.messages(locale) : options.messages[locale] ?? {}

  // `setLocale()` in server code switches the request instance, so it loads from the server messages.
  const catalogs = Object.fromEntries(options.config.locales.map(locale => [locale, async () => ({ messages: messagesOf(locale) })]))
  configureI18n({ ...options.config, catalogs })
  const byRequest = new WeakMap<object, I18n>()
  // Server code keeps the source text of each message. A message without a translation compiles it once here.
  const compiled = new Map<string, ReturnType<typeof compileMessage>>()
  const compile = (message: string) => {
    let result = compiled.get(message)
    if (!result) compiled.set(message, result = compileMessage(message))
    return result
  }
  const create = (locale: string): I18n => {
    const instance = setupI18n({ locale, messages: { [locale]: messagesOf(locale) } })
    instance.setMessagesCompiler(compile)
    return instance
  }

  nitroApp.hooks.hook("request", (event) => {
    const locale = resolveRequestLocale(requestHeaders(event), options.config)
    const instance = create(locale)
    if (event.context) event.context[eventKey] = instance
    if (event.req && typeof event.req === "object") byRequest.set(event.req, instance)
    byRequest.set(event, instance)
    if (!live) return
    // Nitro waits for this promise, so a request after a publish reads the new revision.
    const revision = live.revision
    return live.refresh().then(() => {
      if (live.revision !== revision) instance.load(instance.locale, messagesOf(instance.locale))
    })
  })

  setI18nScope(() => {
    const current = options.current()
    if (!current || typeof current !== "object") return undefined
    return byRequest.get(current) ?? (current as RequestEvent).context?.[eventKey] as I18n | undefined
  })
}

/** The i18n instance that the server created for a request event. */
export function getRequestI18n(event: unknown): I18n | undefined {
  return (event as RequestEvent | undefined)?.context?.[eventKey] as I18n | undefined
}

const catalogHeaders = { "cache-control": "no-cache", "content-type": "application/json; charset=utf-8" }

/**
 * Response of `GET /_vitehub/i18n/<locale>.json`: the published translations of the browser messages. The ETag is the
 * Workspace revision, so a browser downloads a catalog again only after a publish.
 */
export async function i18nCatalogResponse(request: Request): Promise<Response> {
  const state = serverState()
  const file = new URL(request.url).pathname.split("/").pop() ?? ""
  const locale = state?.options.config.locales.find(entry => `${entry}.json` === file)
  if (!state?.live || !locale) return new Response("Not found", { status: 404 })
  await state.live.refresh()
  const etag = `"${state.live.revision}"`
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...catalogHeaders, etag } })
  const body = { revision: state.live.revision, messages: state.live.clientMessages(locale) }
  return new Response(JSON.stringify(body), { headers: { ...catalogHeaders, etag } })
}

export interface SaveTranslationInput {
  locale: string
  /** The source text, as the code writes it. */
  source: string
  context?: string
  translation: string
  /** Defaults to `edited`. */
  review?: TranslationReview
  /** Who made the change, such as a user name or an Agent. */
  by?: string
}

export interface Translations {
  /** The published revision that the server uses, or `build` for the build snapshot. */
  revision(): Promise<string>
  /** The records of one locale. `draft` shows the published records with the saved changes on top. */
  list(locale: string, options?: { ref?: "draft" | "published" }): Promise<Result<TranslationRecords, "I18N_UNKNOWN_LOCALE">>
  /** Save one translation to the `draft` ref. Readers see it after `publish()`. */
  save(input: SaveTranslationInput): Promise<Result<{ id: string, revision: string }, "I18N_UNKNOWN_LOCALE">>
  /** Copy the changed draft records to the `published` ref in one revision. The server uses them on the next request. */
  publish(options?: { message?: string }): Promise<{ revision: string | null, published: number }>
}

function writable(state: ServerState): WritableTranslationsWorkspace {
  const workspace = state.options.workspace
  if (!workspace) throw i18nErrorDiagnostics.I18N_NO_WORKSPACE()
  // SAFETY: `open("write")` returns the writable facade of `useWorkspaceFiles()`, which has `history.commit()`.
  return workspace.open("write") as WritableTranslationsWorkspace
}

async function recordsAt(workspace: TranslationsWorkspace, ref: string, locales: readonly string[]): Promise<Record<string, TranslationRecords>> {
  const head = await workspace.history.head({ ref })
  return head ? await readRevisionRecords(await workspace.history.open(head.id), locales) : {}
}

/**
 * Read, save, and publish translations in the Workspace of `i18n.workspace`. Saves go to the `draft` ref, so people
 * and Agents can prepare translations without changing the site.
 */
export function useTranslations(): Translations {
  const state = serverState()
  if (!state?.options.workspace) throw i18nErrorDiagnostics.I18N_NO_WORKSPACE()
  const { config } = state.options
  const translated = config.locales.filter(locale => locale !== config.sourceLocale)
  const match = (locale: string) => translated.find(entry => entry.toLowerCase() === locale.toLowerCase())
  const unknown = (locale: string) => i18nErrorDiagnostics.I18N_UNKNOWN_LOCALE({ locale, locales: translated })

  return {
    async revision() {
      await state.live?.refresh()
      return state.live?.revision ?? "build"
    },
    async list(locale, options) {
      const entry = match(locale)
      if (!entry) return [unknown(locale), undefined]
      const workspace = writable(state)
      const published = await recordsAt(workspace, publishedRef, [entry])
      if (options?.ref !== "draft") return [undefined, published[entry] ?? {}]
      const draft = await recordsAt(workspace, draftRef, [entry])
      return [undefined, { ...published[entry], ...draft[entry] }]
    },
    async save(input) {
      const entry = match(input.locale)
      if (!entry) return [unknown(input.locale), undefined]
      const workspace = writable(state)
      const id = generateMessageId(input.source, input.context)
      const record: TranslationRecord = {
        source: input.source,
        ...(input.context ? { context: input.context } : {}),
        translation: input.translation,
        review: input.review ?? "edited",
        updatedAt: new Date().toISOString(),
        ...(input.by ? { by: input.by } : {}),
      }
      const head = await workspace.history.head({ ref: draftRef })
      const revision = await workspace.history.commit({
        ref: draftRef,
        ifHead: head?.id ?? null,
        changes: { put: { [recordPath(entry, id)]: `${JSON.stringify(record, null, 2)}\n` } },
        message: `Translate ${id} to ${entry}`,
      })
      return [undefined, { id, revision: revision.id }]
    },
    async publish(options) {
      const workspace = writable(state)
      const [draft, publishedHead] = await Promise.all([
        recordsAt(workspace, draftRef, translated),
        workspace.history.head({ ref: publishedRef }),
      ])
      const published = publishedHead ? await readRevisionRecords(await workspace.history.open(publishedHead.id), translated) : {}
      const put = recordChanges(draft, published)
      const count = Object.keys(put).length
      if (!count) return { revision: publishedHead?.id ?? null, published: 0 }
      const revision = await workspace.history.commit({
        ref: publishedRef,
        ifHead: publishedHead?.id ?? null,
        changes: { put },
        message: options?.message ?? `Publish ${count} translations`,
      })
      await state.live?.refresh({ force: true })
      return { revision: revision.id, published: count }
    },
  }
}
