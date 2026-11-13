import { relative } from "node:path"

import { extractor as babelExtractor, getCatalogs } from "@lingui/cli/api"
import { createVueExtractor } from "@lingui/extractor-vue"

import { messageSegment } from "./record-format.ts"

import type { ExtractedMessage, ExtractorType, LinguiConfigNormalized } from "@lingui/conf"

/** The source text of one message and the places in the code that use it. */
export interface SourceMessage {
  message: string
  context?: string
  /** Diglot's hash of the message: the name of its record in `locales/<locale>/segments/`. */
  hash: string
  /** `file:line`, relative to the project root. */
  origins: string[]
  /** Notes for translators, collected from every use of the message. */
  comments?: string[]
}

/** Source messages by message ID, the key that the runtime looks up. */
export type SourceMessages = Record<string, SourceMessage>

/** The source messages that the last build used. ViteHub writes it, and git does not track it. */
export interface I18nManifest {
  /** Messages by Vite environment, such as `client` or `ssr`. */
  environments: Record<string, SourceMessages>
}

/** Path of the manifest, relative to the project root. */
export const manifestFile = ".vitehub/i18n/manifest.json"

const vueExtractor: ExtractorType = createVueExtractor()

/** Lingui config that can also read messages from Vue templates and scripts. */
export function withExtractors(config: LinguiConfigNormalized): LinguiConfigNormalized {
  return { ...config, extractors: [babelExtractor, vueExtractor] }
}

function sourceMessage(message: string, context: string | undefined, comments?: string[]): SourceMessage {
  return { message, ...(context ? { context } : {}), hash: messageSegment(message, context).hash, origins: [], ...(comments?.length ? { comments: [...new Set(comments)] } : {}) }
}

/** Add one extracted message. Messages with the same ID merge their origins. */
export function addMessage(messages: SourceMessages, message: ExtractedMessage, rootDir: string): void {
  if (message.message === undefined) return
  const entry = messages[message.id] ??= sourceMessage(message.message, message.context)
  if (message.comment) {
    const comments = entry.comments ??= []
    if (!comments.includes(message.comment)) comments.push(message.comment)
  }
  if (!message.origin) return
  const [file, line] = message.origin
  const origin = `${relative(rootDir, file) || file}:${line}`
  if (!entry.origins.includes(origin)) entry.origins.push(origin)
}

/** The messages of one source file, read the same way as `vitehub i18n status` reads them. */
export async function extractFileMessages(file: string, code: string, config: LinguiConfigNormalized): Promise<ExtractedMessage[]> {
  const extractor = [vueExtractor, babelExtractor].find(candidate => candidate.match(file))
  if (!extractor) return []
  const messages: ExtractedMessage[] = []
  await extractor.extract(file, code, message => messages.push(message), { linguiConfig: config })
  return messages
}

/** Read every message in the project code, without a build. */
export async function scanMessages(config: LinguiConfigNormalized): Promise<SourceMessages> {
  const [catalog] = await getCatalogs(withExtractors(config))
  const collected = await catalog?.collect()
  const messages: SourceMessages = {}
  for (const [id, entry] of Object.entries(collected ?? {})) {
    if (entry.message === undefined) continue
    messages[id] = {
      ...sourceMessage(entry.message, entry.context, entry.comments),
      origins: entry.origin.map(([file, line]) => `${file}${line === undefined ? "" : `:${line}`}`),
    }
  }
  return messages
}

/** Merge message uses without losing their origins or translator notes. */
export function mergeMessages(groups: Iterable<SourceMessages>): SourceMessages {
  const result: SourceMessages = {}
  for (const messages of groups) {
    for (const [id, message] of Object.entries(messages)) {
      const entry = result[id] ??= { ...message, origins: [], ...(message.comments ? { comments: [] } : {}) }
      for (const origin of message.origins) if (!entry.origins.includes(origin)) entry.origins.push(origin)
      for (const comment of message.comments ?? []) {
        const comments = entry.comments ??= []
        if (!comments.includes(comment)) comments.push(comment)
      }
    }
  }
  return result
}

/** The messages of every environment in one map. */
export function allMessages(manifest: I18nManifest): SourceMessages {
  return mergeMessages(Object.values(manifest.environments))
}
