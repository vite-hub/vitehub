import { viteHubPageToolsInlineScript, viteHubPageToolsInlineStart, viteHubPageToolsLoader, viteHubPageToolsMarker } from "./page-tools-shared.ts"

function isGeneratedCheck(inline: string): boolean {
  const at = inline.indexOf("import(")
  if (at === -1) return false
  try {
    const path: unknown = JSON.parse(inline.slice(at + 7, -1))
    return typeof path === "string" && path.endsWith(viteHubPageToolsLoader)
      && viteHubPageToolsInlineScript(path.slice(0, -viteHubPageToolsLoader.length)) === `${inline}</script>`
  }
  catch { return false }
}

/** A tag ends at an unquoted `>`, so markup quoted in an attribute stays untouched. */
function tagEnd(text: string): number {
  let quote = ""
  for (let index = 1; index < text.length; index++) {
    const character = text[index]!
    if (quote) {
      if (character === quote) quote = ""
    }
    else if (character === '"' || character === "'") quote = character
    else if (character === ">") return index + 1
  }
  return -1
}

/** Scan HTML tokens across chunks; only active script elements can own the loader marker. */
export function pageToolsHtmlTransform(loader: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  let opaqueEnd: RegExp | undefined
  let rawText = ""
  let inline = ""
  let templates = 0
  let present = false
  let done = false

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      const emit = (text: string) => { if (text) controller.enqueue(encoder.encode(text)) }
      while (pending) {
        if (done) {
          emit(pending)
          pending = ""
          return
        }
        if (opaqueEnd) {
          const end = opaqueEnd.exec(pending)
          const length = end ? end.index + end[0].length : Math.max(0, pending.length - 3)
          emit(pending.slice(0, length))
          pending = pending.slice(length)
          if (!end) return
          opaqueEnd = undefined
          continue
        }
        if (rawText) {
          if (rawText === "plaintext") {
            emit(pending)
            pending = ""
            return
          }
          const end = new RegExp(`</${rawText}(?=[\\t\\n\\f\\r />])`, "i").exec(pending)
          const length = end ? end.index : Math.max(0, pending.length - rawText.length - 3)
          if (inline) inline += pending.slice(0, length)
          else emit(pending.slice(0, length))
          pending = pending.slice(length)
          if (!end) return
          const finish = tagEnd(pending)
          if (finish === -1) return
          if (inline) {
            emit(isGeneratedCheck(inline) ? loader : inline + pending.slice(0, finish))
            inline = ""
            present = true
          }
          else emit(pending.slice(0, finish))
          pending = pending.slice(finish)
          rawText = ""
          continue
        }
        const start = pending.indexOf("<")
        if (start === -1) {
          emit(pending)
          pending = ""
          return
        }
        emit(pending.slice(0, start))
        pending = pending.slice(start)
        if ("<!--".startsWith(pending) || "<![CDATA[".startsWith(pending)) return
        if (pending.startsWith("<!--") || pending.startsWith("<![CDATA[")) {
          opaqueEnd = pending.startsWith("<!--") ? /--!?>/ : /\]\]>/
          const length = pending.startsWith("<!--") ? 4 : 9
          emit(pending.slice(0, length))
          pending = pending.slice(length)
          continue
        }
        if (!/^<[a-z!/?]/i.test(pending)) {
          emit("<")
          pending = pending.slice(1)
          continue
        }
        const finish = tagEnd(pending)
        if (finish === -1) return
        const token = pending.slice(0, finish)
        pending = pending.slice(finish)
        const match = /^<(\/?)([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/i.exec(token)
        const name = match?.[2]?.toLowerCase()
        const closing = match?.[1] === "/"
        if (name === "template") templates = Math.max(0, templates + (closing ? -1 : 1))
        if (name === "body" && closing && !templates) {
          if (!present) emit(loader)
          done = true
        }
        if (!closing && name && /^(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)$/.test(name)) {
          rawText = name
          if (!templates && token === viteHubPageToolsInlineStart) {
            // Retain the candidate until its closing tag is known. EOF must never discard page content.
            inline = token
            present = true
            continue
          }
          if (!templates && name === "script") {
            const attributes = token.replace(/"[^"]*"|'[^']*'/g, "")
            present ||= new RegExp(`\\s${viteHubPageToolsMarker}(?=[\\s=/>])`, "i").test(attributes)
          }
        }
        emit(token)
      }
    },
    flush(controller) {
      const rest = inline + pending + decoder.decode()
      controller.enqueue(encoder.encode(rest + (done || present ? "" : loader)))
    },
  })
}
