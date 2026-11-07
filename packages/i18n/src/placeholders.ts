import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage"

import type { CompiledMessage } from "@lingui/message-utils/compileMessage"

function collect(message: CompiledMessage, names: Set<string>): void {
  for (const token of message) {
    if (typeof token === "string") {
      // Lingui keeps `<Trans>` tags such as `<0>` and `</0>` as text.
      for (const match of token.matchAll(/<\/?(\d+)\/?>/g)) names.add(`<${match[1]}>`)
      continue
    }
    const [name, , format] = token
    names.add(`{${name}}`)
    // Plural and select forms are messages too. Their text is not a placeholder.
    if (format && typeof format === "object") {
      for (const [key, choice] of Object.entries(format)) if (key !== "offset" && Array.isArray(choice)) collect(choice as CompiledMessage, names)
    }
  }
}

/** The arguments such as `{name}` and the tags such as `<0>` of an ICU message, sorted. Throws for invalid ICU. */
export function messagePlaceholders(message: string): string[] {
  const names = new Set<string>()
  collect(compileMessageOrThrow(message), names)
  return [...names].sort()
}

/** Why a translation does not fit its source text, or `undefined` when it fits. */
export function translationProblem(source: string, translation: string): string | undefined {
  let actual: string[]
  try {
    actual = messagePlaceholders(translation)
  }
  catch (error) {
    return `It is not valid ICU MessageFormat: ${(error as Error).message}`
  }
  const expected = messagePlaceholders(source)
  if (expected.join() === actual.join()) return undefined
  return `It must keep the placeholders and tags of the source: ${expected.join(" ") || "none"}. It has ${actual.join(" ") || "none"}.`
}
