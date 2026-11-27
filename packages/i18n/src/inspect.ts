import { findPreviousTranslations } from "./lineage.ts"
import { recordsRoot } from "./lingui.ts"
import { scanMessages } from "./manifest.ts"
import { isVisible, readRecords } from "./records.ts"

import type { LinguiConfigNormalized } from "@lingui/conf"
import type { SourceMessages } from "./manifest.ts"
import type { RecordProblem, TranslationRecords } from "./records.ts"

export interface I18nLocaleStatus {
  locale: string
  /** True for the language that the code is written in. */
  source: boolean
  /** Folder of the records, relative to the project root. The source locale has none. */
  folder: string
  /** Messages in the code. */
  messages: number
  /** Messages with a translation that readers see. The source locale counts every message as translated. */
  translated: number
  /** Messages that show the source text in this locale: no record, a rejected record, or a record that fails validation. */
  missing: number
  /** Missing messages whose source text changed a little. Their old translation is a starting point. */
  changed: number
  /** Records of messages that the code no longer has. */
  unused: number
  /** Record files that ViteHub cannot use. */
  problems: RecordProblem[]
}

export interface I18nStatus {
  messages: SourceMessages
  locales: I18nLocaleStatus[]
  records: Record<string, TranslationRecords>
}

/** Read the messages of the code and the records of each locale, and compare them. */
export async function inspectI18n(config: LinguiConfigNormalized): Promise<I18nStatus> {
  const messages = await scanMessages(config)
  const ids = Object.keys(messages)
  const root = recordsRoot(config.rootDir)
  const records: Record<string, TranslationRecords> = {}
  const locales = await Promise.all(config.locales.map(async (locale): Promise<I18nLocaleStatus> => {
    const source = locale === config.sourceLocale
    const read = source ? { records: {}, problems: [] } : await readRecords(root, locale)
    records[locale] = read.records
    const translated = source ? ids.length : ids.filter((id) => {
      const record = read.records[id]
      return !!record && isVisible(record)
    }).length
    return {
      locale,
      source,
      folder: source ? "" : `locales/${locale}`,
      messages: ids.length,
      translated,
      missing: ids.length - translated,
      changed: source ? 0 : findPreviousTranslations(messages, read.records).size,
      unused: Object.keys(read.records).filter(id => !(id in messages)).length,
      problems: read.problems,
    }
  }))
  return { messages, locales, records }
}
