import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { normalizePath } from "./comments.mjs"

const repoRoot = resolve(import.meta.dirname, "../..")
const vp = fileURLToPath(new URL("./bin/vp", import.meta.resolve("vite-plus/package.json")))

export function bannedComments(paths) {
  const result = spawnSync(process.execPath, [vp, "lint", "--ignore-path", ".gitignore", "-f", "json", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, VITEHUB_COMMENT_BASELINE: "off" },
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (!result.stdout.trim().startsWith("{")) throw new Error(`vp lint failed:\n${result.stderr || result.stdout}`)
  const byFile = new Map()
  for (const diagnostic of JSON.parse(result.stdout).diagnostics) {
    if (diagnostic.code !== "vitehub(no-comments)") continue
    const file = normalizePath(diagnostic.filename)
    const spans = byFile.get(file) ?? []
    spans.push(diagnostic.labels[0].span)
    byFile.set(file, spans)
  }
  return byFile
}

export function fileSpans(text, spans) {
  const bytes = Buffer.from(text)
  const index = offset => bytes.subarray(0, offset).toString("utf8").length
  return spans.map(span => ({ ...span, offset: index(span.offset), length: index(span.offset + span.length) - index(span.offset) }))
}

export function deleteSpans(text, spans) {
  let out = text
  for (const { offset, length } of [...spans].sort((a, b) => b.offset - a.offset)) {
    const end = offset + length
    const lineStart = out.lastIndexOf("\n", offset - 1) + 1
    const newline = out.indexOf("\n", end)
    const lineEnd = newline === -1 ? out.length : newline
    const before = out.slice(lineStart, offset)
    const after = out.slice(end, lineEnd)
    if (!before.trim() && !after.trim()) {
      const removeEnd = newline === -1 ? out.length : newline + 1
      const previousBlank = lineStart === 0 || /\n[ \t]*\n$/.test(out.slice(0, lineStart))
      const nextLineEnd = out.indexOf("\n", removeEnd)
      const nextBlank = removeEnd < out.length && !out.slice(removeEnd, nextLineEnd === -1 ? out.length : nextLineEnd).trim()
      out = out.slice(0, lineStart) + out.slice(previousBlank && nextBlank && nextLineEnd !== -1 ? nextLineEnd + 1 : removeEnd)
      const open = /\{[ \t]*\n[ \t]*$/.exec(out.slice(0, lineStart))
      const close = /^[ \t]*\}/.exec(out.slice(lineStart))
      if (open && close) out = `${out.slice(0, open.index + 1)}${out.slice(lineStart + close[0].length - 1)}`
    }
    else if (out.startsWith("/*", offset)) {
      const lineBreaks = out.slice(offset, end).replace(/[^\r\n\u2028\u2029]/g, "")
      const separator = lineBreaks || (before && after && !/\s$/.test(before) && !/^\s/.test(after) ? " " : "")
      out = out.slice(0, offset) + separator + out.slice(end)
    }
    else if (before.trim()) {
      out = out.slice(0, offset).replace(/[ \t]+$/, "") + out.slice(end)
    }
    else {
      out = out.slice(0, offset) + out.slice(end).replace(/^[ \t]+/, "")
    }
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const list = args.includes("--list")
  const paths = args.filter(arg => arg !== "--list")
  const byFile = bannedComments(paths.length ? paths : ["."])
  let count = 0
  for (let [file, spans] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const path = join(repoRoot, file)
    const text = readFileSync(path, "utf8")
    spans = fileSpans(text, spans)
    count += spans.length
    if (list) {
      for (const span of spans.sort((a, b) => a.offset - b.offset)) {
        console.log(`${file}:${span.line}: ${text.slice(span.offset, span.offset + span.length).replace(/\s*\n\s*/g, " ⏎ ")}`)
      }
    }
    else {
      writeFileSync(path, deleteSpans(text, spans))
    }
  }
  console.error(`${list ? "Found" : "Deleted"} ${count} comments in ${byFile.size} files.`)
}

if (process.argv[1] === import.meta.filename) main()
