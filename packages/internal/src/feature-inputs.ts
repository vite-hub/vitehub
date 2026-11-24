function isLocaleTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1
  }
  catch {
    return false
  }
}

export function i18nLocaleListProblem(locales: unknown): string | undefined {
  if (!Array.isArray(locales) || locales.length === 0) return "`i18n.locales` is empty."
  const seen = new Set<string>()
  for (const locale of locales) {
    if (typeof locale !== "string" || !isLocaleTag(locale)) return `\`${String(locale)}\` is not a BCP 47 language tag.`
    if (seen.has(locale.toLowerCase())) return `\`${locale}\` is listed twice.`
    seen.add(locale.toLowerCase())
  }
}

export function mcpPublicRouteNeedsSignedAuth(publicRoute: string | undefined, auth: boolean | "optional"): boolean {
  return !!publicRoute && auth !== true
}
