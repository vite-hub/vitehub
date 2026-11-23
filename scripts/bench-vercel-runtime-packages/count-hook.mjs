import { appendFileSync } from "node:fs"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"

const output = process.env.VITEHUB_RUNTIME_PACKAGE_COUNTS
const staging = /[\\/]\.vitehub-runtime-packages-[^\\/]+[\\/]node_modules[\\/]/
const stagingRoot = /[\\/]\.vitehub-runtime-packages-[^\\/]+$/
const counts = { copyMs: 0, copyPasses: 0, cpuMs: 0, filesCopied: 0, packageCopies: 0 }
const started = new Map()

const { copyFile, mkdtemp, rm } = fs
fs.mkdtemp = async (prefix, ...rest) => {
  const directory = await mkdtemp(prefix, ...rest)
  if (String(prefix).includes(".vitehub-runtime-packages-")) {
    counts.copyPasses++
    started.set(directory, performance.now())
  }
  return directory
}
fs.rm = async (path, ...rest) => {
  if (staging.test(String(path))) counts.packageCopies++
  const result = await rm(path, ...rest)
  if (stagingRoot.test(String(path)) && started.has(String(path))) {
    counts.copyMs += Math.round(performance.now() - started.get(String(path)))
    started.delete(String(path))
  }
  return result
}
fs.copyFile = async (source, target, ...rest) => {
  if (staging.test(String(target))) counts.filesCopied++
  return await copyFile(source, target, ...rest)
}
syncBuiltinESMExports()

process.on("exit", () => {
  const { system, user } = process.cpuUsage()
  counts.cpuMs = Math.round((system + user) / 1000)
  if (output && counts.copyPasses) appendFileSync(output, `${JSON.stringify(counts)}\n`)
})
