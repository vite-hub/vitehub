import { characterEntitiesLegacy } from "character-entities-legacy"
import { parseMarkdown } from "comark"
import { markdownTemplateErrorDiagnostics } from "./error-diagnostics.ts"

const legacyHtmlReferences = new Set(characterEntitiesLegacy)

export async function safeLinkDestination(value: string, path: string): Promise<string> {
  const suffixIndex = value.search(/[?#]/)
  const scheme = value.match(/^([a-z][a-z\d+.-]*):/i)
  const hierarchical = !scheme
    || /^(?:file|ftp|https?|wss?)$/i.test(scheme[1]!)
  const hasPathBackslash = hierarchical
    && value.slice(0, suffixIndex < 0 ? undefined : suffixIndex).includes("\\")
  const hasHtmlReferencePrefix = /&#(?:\d+|x[\dA-F]+)/i.test(value)
    || [...value.matchAll(/&([A-Za-z][A-Za-z\d]*)(?=[^=A-Za-z\d]|$)/g)]
      .some(match => legacyHtmlReferences.has(match[1]!))
  const hasBracketedAuthority = /^(?:[a-z][a-z\d+.-]*:)?\/{2,}(?:[^/?#]*@)?\[/i.test(value)
    || /^(?:file|ftp|https?|wss?):\/*(?:[^/?#]*@)?\[/i.test(value)
  if (value.startsWith(" ") || value.endsWith(" ") || /%(?![\dA-F]{2})/i.test(value) || hasPathBackslash || hasHtmlReferencePrefix || hasBracketedAuthority || [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 32 || codePoint === 127
  })) {
    throw markdownTemplateErrorDiagnostics.MARKDOWN_TEMPLATE_R0011({ message: `[vitehub] Markdown template link binding "{{ ${path} }}" must resolve to a safe destination.` })
  }
  let encoded: string
  try {
    encoded = encodeURI(value)
    encoded = encoded
      .replace(/%25([\dA-F]{2})/gi, "%$1")
      .replace(/[()]/g, character => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`)
  }
  catch {
    throw markdownTemplateErrorDiagnostics.MARKDOWN_TEMPLATE_R0012({ message: `[vitehub] Markdown template link binding "{{ ${path} }}" must resolve to a safe destination.` })
  }

  const tree = await parseMarkdown(`[link](<${encoded}>)`)
  const paragraph = tree.nodes[0]
  const link = Array.isArray(paragraph) && paragraph[0] === "p" ? paragraph[2] : undefined
  if (!link || !Array.isArray(link) || link[0] !== "a" || link[1].href !== encoded) {
    throw markdownTemplateErrorDiagnostics.MARKDOWN_TEMPLATE_R0013({ message: `[vitehub] Markdown template link binding "{{ ${path} }}" must resolve to a safe destination.` })
  }
  return encoded
}
