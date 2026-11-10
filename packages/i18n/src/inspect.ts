import { getCatalogs } from "@lingui/cli/api"
import { createVueExtractor } from "@lingui/extractor-vue"
import babelExtractor from "@lingui/cli/api/extractors/babel"

import type { LinguiConfigNormalized } from "@lingui/conf"

export interface I18nLocaleStatus {
  locale: string
  /** True for the language that the code is written in. */
  source: boolean
  /** Path of the PO catalog, relative to the project root. */
  catalog: string
  /** Messages in the catalog. */
  messages: number
  /** Messages with a translation. The source locale counts every message as translated. */
  translated: number
  /** Messages that show the source text in this locale. */
  missing: number
}

/** Lingui config that can also read messages from Vue templates and scripts. */
export function withExtractors(config: LinguiConfigNormalized): LinguiConfigNormalized {
  return { ...config, extractors: [babelExtractor, createVueExtractor()] }
}

/** Translation coverage of each locale, read from the PO catalogs. */
export async function inspectI18n(config: LinguiConfigNormalized): Promise<I18nLocaleStatus[]> {
  const [catalog] = await getCatalogs(config)
  if (!catalog) return []
  const all = await catalog.readAll()
  return config.locales.map((locale) => {
    const messages = Object.values(all[locale] ?? {}).filter(message => !message.obsolete)
    const source = locale === config.sourceLocale
    const translated = source ? messages.length : messages.filter(message => Boolean(message.translation)).length
    return {
      locale,
      source,
      catalog: `locales/${locale}.po`,
      messages: messages.length,
      translated,
      missing: messages.length - translated,
    }
  })
}

/** Collect messages from the code into `locales/<locale>.po`. Existing translations stay. */
export async function extractMessages(config: LinguiConfigNormalized, options: { clean?: boolean } = {}): Promise<I18nLocaleStatus[]> {
  const extracting = withExtractors(config)
  const [catalog] = await getCatalogs(extracting)
  if (!catalog) return []
  await catalog.make({ clean: options.clean ?? true, overwrite: false, orderBy: extracting.orderBy })
  return inspectI18n(extracting)
}
