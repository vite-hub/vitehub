function stripMarkdownCode(template: string): string {
  let fence: { marker: string, length: number, listIndented: boolean } | undefined
  let inList = false
  let previousLineBlank = true
  return template.split("\n").map((line) => {
    const content = line.replace(/^(?: {0,3}> ?)+/, "")
    if (!fence) {
      const listIndented = inList && /^ {4}(?:`{3,}|~{3,})/.test(content)
      const opening = (listIndented ? content.slice(4) : content).match(/^ {0,3}(`{3,}|~{3,})/)
      if (!opening) {
        if (/^ {0,3}(?:[-+*]|\d+[.)])\s+/.test(content)) inList = true
        else if (content.trim() && !/^ {2,}/.test(content)) inList = false
        const indentedCode = (!inList && previousLineBlank && /^(?: {4}|\t)/.test(content))
          || (inList && previousLineBlank && /^(?: {8}| {4}\t|\t{2})/.test(content))
        previousLineBlank = content.trim() === ""
        return indentedCode ? "" : line
      }
      fence = { marker: opening[1]![0]!, length: opening[1]!.length, listIndented }
      previousLineBlank = false
      return ""
    }
    const closing = (fence.listIndented ? content.replace(/^ {4}/, "") : content).match(/^ {0,3}(`+|~+)\s*$/)?.[1]
    if (closing?.[0] === fence.marker && closing.length >= fence.length) fence = undefined
    previousLineBlank = false
    return ""
  }).join("\n")
}

export function extractMarkdownTemplateImportSpecifiers(template: string): string[] {
  const visible = stripMarkdownCode(template)
    .replace(/(`+)[\s\S]*?\1/g, "")
    .replace(/(!?\[[^\]]*\])\([^)]*\)/g, "$1")
    .replace(/^ {0,3}\[[^\]]+\]:\s*\S+/gm, "")
    .replace(/<[^>]*>/g, "")
  const specifiers = new Set<string>()
  for (const match of visible.matchAll(/@(\.\.?\/[^\s<>{}[\]]+)/g)) {
    const token = match[1]!
    const trailing = token.match(/[.,;:!?)]*$/)?.[0] || ""
    specifiers.add(token.slice(0, token.length - trailing.length))
  }
  return [...specifiers]
}
