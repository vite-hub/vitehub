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

function placeholders(message: CompiledMessage): string[] {
  const names = new Set<string>()
  collect(message, names)
  return [...names].sort()
}

/** The arguments such as `{name}` and the tags such as `<0>` of an ICU message, sorted. Throws for invalid ICU. */
export function messagePlaceholders(message: string): string[] {
  return placeholders(compileMessageOrThrow(message))
}

const maxTagPaths = 256

/** Tag sequences for each rendered ICU branch, bounded before further expansion. Equal branches count once. */
function tagPaths(message: CompiledMessage): Set<string> | undefined {
  let paths = new Set([""])
  for (const token of message) {
    let choices: Set<string>
    if (typeof token === "string") {
      choices = new Set([token.match(/<\/?\d+\/?>/g)?.join("") ?? ""])
    }
    else {
      const format = token[2]
      if (!format || typeof format !== "object") continue
      choices = new Set()
      for (const [key, choice] of Object.entries(format)) {
        if (key === "offset" || !Array.isArray(choice)) continue
        const branches = tagPaths(choice as CompiledMessage)
        if (!branches) return undefined
        for (const branch of branches) {
          choices.add(branch)
          if (choices.size > maxTagPaths) return undefined
        }
      }
    }
    const next = new Set<string>()
    for (const path of paths) {
      for (const choice of choices) {
        next.add(path + choice)
        if (next.size > maxTagPaths) return undefined
      }
    }
    paths = next
  }
  return paths
}

function tagSignature(path: string): string {
  return (path.match(/<\/?\d+\/?>/g) ?? []).sort().join("")
}

function richTextProblem(source: CompiledMessage, translation: CompiledMessage): string | undefined {
  const actual = tagPaths(translation)
  if (!actual) return `It must have at most ${maxTagPaths} distinct numeric rich-text tag sequences across ICU branches.`
  const expected = tagPaths(source)
  if (!expected) return `The source must have at most ${maxTagPaths} distinct numeric rich-text tag sequences across ICU branches.`
  for (const path of actual) {
    const stack: string[] = []
    for (const match of path.matchAll(/<(\/?)(\d+)(\/?)>/g)) {
      if (match[1]) {
        if (match[3] || stack.pop() !== match[2]) return "It must have balanced numeric rich-text tags."
      }
      else if (!match[3]) stack.push(match[2]!)
    }
    if (stack.length) return "It must have balanced numeric rich-text tags."
  }
  const expectedSignatures = [...new Set([...expected].map(tagSignature))].sort()
  const actualSignatures = [...new Set([...actual].map(tagSignature))].sort()
  if (expectedSignatures.join() !== actualSignatures.join()) return "It must keep each numeric rich-text tag occurrence of the source."
  return undefined
}

/** Why a translation does not fit its source text, or `undefined` when it fits. */
export function translationProblem(source: string, translation: string): string | undefined {
  let compiled: CompiledMessage
  try {
    compiled = compileMessageOrThrow(translation)
  }
  catch (error) {
    return `It is not valid ICU MessageFormat: ${(error as Error).message}`
  }
  const sourceMessage = compileMessageOrThrow(source)
  const expected = placeholders(sourceMessage)
  const actual = placeholders(compiled)
  if (expected.join() === actual.join()) return richTextProblem(sourceMessage, compiled)
  return `It must keep the placeholders and tags of the source: ${expected.join(" ") || "none"}. It has ${actual.join(" ") || "none"}.`
}
