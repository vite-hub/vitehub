import packageJson from "../package.json" with { type: "json" }

/**
 * Codemods add ViteHub packages at `^<codemods version>`. Output fixtures write that range as `"^<version>"`, so a
 * release that bumps the codemods version changes no fixture. Only that exact range is replaced.
 */
export function withVersionPlaceholder(text: string | null): string | null {
  return text === null ? null : text.replaceAll(`"^${packageJson.version}"`, `"^<version>"`)
}

export const codemodsRange = `^${packageJson.version}`
