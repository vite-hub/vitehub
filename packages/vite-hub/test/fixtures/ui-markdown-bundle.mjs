import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import viteHubUI from "@vite-hub/ui/vite"
import vue from "@vitejs/plugin-vue"
import { build } from "vite"

const [root] = process.argv.slice(2)
const result = await build({
  build: { minify: true, write: false },
  cacheDir: join(root, ".vite"),
  configFile: false,
  logLevel: "silent",
  plugins: [vue(), viteHubUI()],
  root,
})
const output = (Array.isArray(result) ? result : [result]).flatMap(entry => "output" in entry ? entry.output : [])
const files = new Map(output.map(file => [file.fileName, file]))
const bytes = file => file.type === "chunk" ? Buffer.byteLength(file.code) : Buffer.byteLength(file.source)
const loadsPierre = file => file.type === "chunk" && file.moduleIds.some(id => id.includes("@pierre/") || id.includes("code-view"))
const entry = output.find(file => file.type === "chunk" && file.isEntry)
const initial = new Set()
const visit = (fileName) => {
  if (initial.has(fileName)) return
  initial.add(fileName)
  const file = files.get(fileName)
  if (file?.type === "chunk") {
    file.imports.forEach(visit)
    file.viteMetadata?.importedCss.forEach(cssFileName => initial.add(cssFileName))
  }
}
visit(entry.fileName)
const initialFiles = [...initial].map(fileName => files.get(fileName))
await writeFile(join(root, "bundle-report.json"), JSON.stringify({
  files: output.length,
  initialBytes: initialFiles.reduce((total, file) => total + bytes(file), 0),
  initialFiles: initialFiles.length,
  initialPierreFiles: initialFiles.filter(loadsPierre).map(file => file.fileName),
  pierreFiles: output.filter(loadsPierre).map(file => file.fileName),
  totalBytes: output.reduce((total, file) => total + bytes(file), 0),
}))
