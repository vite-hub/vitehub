// Kept apart from esbuild.ts so that packages which only need these helpers do not import esbuild.

export interface ViteAlias {
  customResolver?: boolean
  find: string | RegExp
  replacement: string
}

export const encodedAliasPrefixMarker = "\0vitehub-prefix:"
export const encodedAliasExactMarker = "\0vitehub-exact:"

interface StringAlias {
  find: string | RegExp
  replacement: string
}

export function encodeProviderOutputAliases(configAliases: readonly StringAlias[]): Record<string, string> {
  const aliases: Record<string, string> = Object.create(null)
  for (const [index, alias] of configAliases.entries()) {
    if (alias.find instanceof RegExp) continue
    const exactSpecifier = Object.hasOwn(aliases, alias.find) ? `${alias.find}${encodedAliasExactMarker}${index}` : alias.find
    aliases[exactSpecifier] = alias.replacement
    if (alias.find.endsWith("/")) {
      const prefixSpecifier = `${alias.find}/${encodedAliasPrefixMarker}${index}`
      aliases[prefixSpecifier] = `${alias.replacement.replace(/\/$/, "")}/`
    }
    else {
      aliases[`${alias.find}/${encodedAliasPrefixMarker}${index}`] = `${alias.replacement.replace(/\/$/, "")}/`
    }
  }
  return aliases
}

/** Select the runtime constants from one resolved Vite configuration. */
export function resolveViteHubBundleDefines(config: { define?: Record<string, unknown> }): Record<string, string> {
  const defines: Record<string, string> = {}
  for (const name of ["__VITEHUB_PUBLIC_URL__", "__VITEHUB_APP_BASE_URL__"]) {
    const value = config.define?.[name]
    if (typeof value === "string") defines[name] = value
  }
  return defines
}
