import { createCompiledCatalog, getCatalogDependentFiles, getCatalogForFile, getCatalogs } from "@lingui/cli/api"

import type { LinguiConfigNormalized } from "@lingui/conf"

type CompiledMessages = Record<string, unknown>

async function translationsFor(config: LinguiConfigNormalized, locale: string): Promise<Record<string, string>> {
  const [catalog] = await getCatalogs(config)
  if (!catalog) return {}
  const { messages } = await catalog.getTranslations(locale, {
    fallbackLocales: config.fallbackLocales,
    sourceLocale: config.sourceLocale,
    missingBehavior: "source",
  })
  return messages
}

function compiledMessages(locale: string, messages: Record<string, string>): CompiledMessages {
  const { source } = createCompiledCatalog(locale, messages, { namespace: "json" })
  const parsed = JSON.parse(source) as CompiledMessages & { messages?: CompiledMessages }
  return parsed.messages ?? parsed
}

/**
 * Compiled messages of every locale, for the server. A message without a translation falls back to the source
 * language, so a page never shows a message ID.
 */
export async function compileCatalogs(config: LinguiConfigNormalized): Promise<Record<string, CompiledMessages>> {
  const result: Record<string, CompiledMessages> = {}
  for (const locale of config.locales) {
    result[locale] = compiledMessages(locale, await translationsFor(config, locale))
  }
  return result
}

/** A JavaScript module with `export const messages` for one `locales/<locale>.po` file. */
export async function compileCatalogModule(config: LinguiConfigNormalized, relativeFile: string): Promise<{ code: string, dependencies: string[] } | undefined> {
  const file = getCatalogForFile(relativeFile, await getCatalogs(config))
  if (!file) return undefined
  const { messages } = await file.catalog.getTranslations(file.locale, {
    fallbackLocales: config.fallbackLocales,
    sourceLocale: config.sourceLocale,
    missingBehavior: "source",
  })
  const { source } = createCompiledCatalog(file.locale, messages, { namespace: "es" })
  return { code: source, dependencies: await getCatalogDependentFiles(file.catalog, file.locale) }
}
