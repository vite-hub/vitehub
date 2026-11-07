// Pure helpers, so the server runtime reads records on any host.

/** How far a person checked a translation. */
export type TranslationReview = "machine" | "edited" | "verified"

/** One translation of one message. ViteHub keeps it in `locales/<locale>/<file>.json`. */
export interface TranslationRecord {
  /** The source text of the message. Its message ID is a hash of this text and `context`. */
  source: string
  /** The context of the message, when the code gives one. */
  context?: string
  /** The translated message, in ICU MessageFormat with the same placeholders as `source`. */
  translation: string
  /** `machine` for a draft from a model, `edited` after a person changed it, `verified` after a person checked it. */
  review?: TranslationReview
  updatedAt?: string
  /** Who wrote the last change. */
  by?: string
}

/** Translations of one locale, by message ID. */
export type TranslationRecords = Record<string, TranslationRecord>

const base64url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const idRe = /^[\w-]{6}$/
const fileRe = /^([\da-f]{9})\.json$/

/**
 * Message IDs differ in letter case, and macOS and Windows file systems ignore case. The file name is the ID as 9
 * hex digits instead, so two IDs never share a file.
 */
export function recordFileName(id: string): string {
  if (!idRe.test(id)) throw new TypeError(`Invalid message ID: ${id}`)
  let bits = 0n
  for (const char of id) bits = (bits << 6n) | BigInt(base64url.indexOf(char))
  return `${bits.toString(16).padStart(9, "0")}.json`
}

export function idFromFileName(name: string): string | undefined {
  const match = fileRe.exec(name)
  if (!match) return undefined
  let bits = BigInt(`0x${match[1]}`)
  let id = ""
  for (let index = 0; index < 6; index++) {
    id = base64url[Number(bits & 63n)] + id
    bits >>= 6n
  }
  return id
}

/** Path of a record, relative to the records folder. */
export function recordPath(locale: string, id: string): string {
  return `${locale}/${recordFileName(id)}`
}

export function isRecord(value: unknown): value is TranslationRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.source === "string" && typeof record.translation === "string"
    && (record.context === undefined || typeof record.context === "string")
}

