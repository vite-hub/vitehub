import packageJson from "../package.json" with { type: "json" }

const vitehubRange = new RegExp(`("(?:vite-hub|@vite-hub/[^"]+)": )"\\^${packageJson.version.replaceAll(".", "\\.")}"`, "g")

/**
 * Codemods add ViteHub packages at `^<codemods version>`. Output fixtures write that range as `"^<version>"`, so a
 * release that bumps the codemods version changes no fixture. Only a ViteHub package key with that exact range is
 * replaced, so an app dependency that shares the version (such as `"nuxt-auth-utils": "^0.6.0"`) keeps its range.
 */
export function withVersionPlaceholder(text: string | null): string | null {
  return text === null ? null : text.replace(vitehubRange, `$1"^<version>"`)
}

export const codemodsRange = `^${packageJson.version}`
