import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)

it.each(["configured", "disabled", "absent"] as const)("runs Agent KV loading in production output with KV %s", async (mode) => {
  const cache = resolve(import.meta.dirname, "../node_modules/.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "optional-kv-build-"))
  try {
    const entry = join(root, "entry.ts")
    const loader = resolve(import.meta.dirname, "../src/internal/optional-kv.ts")
    await writeFile(entry, [
      `import { importOptionalKV } from ${JSON.stringify(loader)}`,
      `export { importOptionalKV }`,
      ...(mode === "absent" ? [] : [`import { kv } from "@vite-hub/kv"`]),
      `export async function check() {`,
      ...(mode === "absent" ? [
        `  return typeof importOptionalKV`,
      ] : [
        `  const loaded = await importOptionalKV()`,
        `  if (loaded.kv !== kv) throw new Error("Connector and host use different KV instances")`,
        `  const [error] = await loaded.kv.set("teams:thread", { id: "root-1" })`,
        `  if (error) throw error`,
        `  const [readError, receipt] = await kv.get("teams:thread")`,
        `  if (readError) throw readError`,
        `  return receipt.id`,
      ]),
      `}`,
    ].join("\n"))
    const builder = join(root, "build.mjs")
    await writeFile(builder, [
      `import { build } from ${JSON.stringify(import.meta.resolve("vite"))}`,
      `import { hubAgent } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../dist/vite.js")).href)}`,
      `import { hubKv } from ${JSON.stringify(import.meta.resolve("@vite-hub/kv/vite"))}`,
      `await build({`,
      `  root: ${JSON.stringify(root)}, configFile: false, logLevel: "silent", agent: false,`,
      `  plugins: [hubAgent(), ${mode === "absent" ? "" : "hubKv()"}],`,
      `  kv: ${JSON.stringify(mode === "disabled" ? false : { driver: "fs-lite", base: join(root, "kv") })},`,
      `  ssr: { noExternal: true },`,
      `  build: { ssr: ${JSON.stringify(entry)}, outDir: "dist", minify: false,`,
      `    rolldownOptions: { output: { entryFileNames: "entry.mjs" } },`,
      `  },`,
      `})`,
    ].join("\n"))
    await execFileAsync(process.execPath, [builder])
    const runner = join(root, "check.mjs")
    await writeFile(runner, [
      `import assert from "node:assert/strict"`,
      `import { isBuiltin, registerHooks } from "node:module"`,
      `const output = new URL("./dist/", import.meta.url).href`,
      `registerHooks({ resolve(specifier, context, next) {`,
      `  const result = next(specifier, context)`,
      `  if (!isBuiltin(result.url) && !result.url.startsWith(output)) throw new Error("Output escaped to installed dependencies: " + specifier)`,
      `  return result`,
      `} })`,
      `const { check } = await import("./dist/entry.mjs")`,
      mode === "disabled"
        ? `await assert.rejects(check(), { code: "KV_DISABLED" })`
        : `assert.equal(await check(), ${JSON.stringify(mode === "absent" ? "function" : "root-1")})`,
      `console.log("passed")`,
    ].join("\n"))
    const { stdout } = await execFileAsync(process.execPath, [runner])
    expect(stdout.trim()).toBe("passed")
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
