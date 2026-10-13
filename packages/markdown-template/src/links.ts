import { characterEntitiesLegacy } from "character-entities-legacy"
import { decodeHTMLAttribute } from "entities"
import { parseMarkdown } from "comark"
import { markdownTemplateErrorDiagnostics } from "./error-diagnostics.ts"

const legacyHtmlReferences = new Set(characterEntitiesLegacy)

export async function safeLinkDestination(value: string, path: string, options: { decodeHtmlEntities?: boolean } = {}): Promise<string> {
  // Authored HTML attributes are entity-decoded by browsers before navigation.
  // Validate the decoded value so encoded schemes cannot bypass the URL policy,
  // while encoding the result later lets the HTML renderer restore safe entities.
  const decodedValue = options.decodeHtmlEntities ? decodeHTMLAttribute(value) : value
  const suffixIndex = decodedValue.search(/[?#]/)
  const scheme = decodedValue.match(/^([a-z][a-z\d+.-]*):/i)
  const hierarchical = !scheme
    || /^(?:file|ftp|https?|wss?)$/i.test(scheme[1]!)
  const hasPathBackslash = hierarchical
    && decodedValue.slice(0, suffixIndex < 0 ? undefined : suffixIndex).includes("\\")
  const hasHtmlReferencePrefix = !options.decodeHtmlEntities && (/&#(?:\d+|x[\dA-F]+)/i.test(value)
    || [...value.matchAll(/&([A-Za-z][A-Za-z\d]*)(?=[^=A-Za-z\d]|$)/g)]
      .some(match => legacyHtmlReferences.has(match[1]!)))
  const hasBracketedAuthority = /^(?:[a-z][a-z\d+.-]*:)?\/{2,}(?:[^/?#]*@)?\[/i.test(decodedValue)
    || /^(?:file|ftp|https?|wss?):\/*(?:[^/?#]*@)?\[/i.test(decodedValue)
  if (decodedValue.startsWith(" ") || decodedValue.endsWith(" ") || /%(?![\dA-F]{2})/i.test(decodedValue) || hasPathBackslash || hasHtmlReferencePrefix || hasBracketedAuthority || [...decodedValue].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 32 || codePoint === 127
  })) {
    throw markdownTemplateErrorDiagnostics.MARKDOWN_TEMPLATE_R0011({ message: `[vitehub] Markdown template link binding "{{ ${path} }}" must resolve to a safe destination.` })
  }
  let encoded: string
  try {
    encoded = encodeURI(decodedValue)
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
