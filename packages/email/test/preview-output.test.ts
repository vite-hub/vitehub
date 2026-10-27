import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { build } from "esbuild"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { afterEach, expect, it } from "vitest"

import { EMAIL_DEFINITION_ID, hubEmail } from "../src/vite.ts"

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

it.each(["serve", "build"] as const)("previews generated %s templates in a separate runtime without source files", async (command) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-email-runtime-"))
  tempDirs.push(root)
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir")
  const serverDirs = [join(root, "app", "server"), join(root, "layer", "server")]
  for (const dir of serverDirs) await mkdir(join(dir, "emails"), { recursive: true })
  await writeFile(join(serverDirs[0]!, "emails", "welcome.md"), "# Hello {{ data.name }}\n")
  await writeFile(join(serverDirs[1]!, "emails", "receipt.md"), "Receipt {{ data.id }}\n")
  const plugin = hubEmail({ driver: "resend" })
  if (!(plugin.config instanceof Function) || !(plugin.configResolved instanceof Function)) throw new Error("Expected Email config hooks")
  const config = { root, [VITEHUB_SERVER_DIRS]: serverDirs }
  await Reflect.apply(plugin.config, undefined, [config, { command, mode: command === "serve" ? "development" : "production" }])
  await Reflect.apply(plugin.configResolved, undefined, [{ root }])
  let alias: Record<string, string>
  if (command === "serve") {
    // Nitro's runtime resolver replays these Vite hooks in development.
    if (!(plugin.resolveId instanceof Function) || !(plugin.load instanceof Function)) throw new Error("Expected Email runtime hooks")
    const id: unknown = await Reflect.apply(plugin.resolveId, undefined, [EMAIL_DEFINITION_ID])
    const source: unknown = await Reflect.apply(plugin.load, undefined, [id])
    if (typeof source !== "string") throw new Error("Expected generated runtime source")
    const virtual = join(root, "virtual-definition.mjs")
    await writeFile(virtual, source)
    alias = { [EMAIL_DEFINITION_ID]: virtual }
  }
  else {
    alias = await plugin.vitehub.providerOutput!.getImportAliases!()
  }
  const output = join(root, "runtime.mjs")
  await build({
    alias,
    bundle: true,
    format: "esm",
    outfile: output,
    packages: "external",
    platform: "node",
    tsconfigRaw: {},
    stdin: {
      contents: `
        import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
        import { emailOperations } from ${JSON.stringify(resolve("src/operations.ts"))}
        const registry = createOperationRegistry([{ operations: emailOperations }])
        const context = { access: { mode: "app", sections: ["email"] }, surface: "console", user: null }
        const results = await Promise.all([
          runOperation(registry, "email.preview", { template: "welcome", data: { name: "Ada" } }, context),
          runOperation(registry, "email.preview", { template: "receipt", data: { id: 42 } }, context),
          runOperation(registry, "email.preview", { template: "missing" }, context),
          runOperation(registry, "email.preview", { template: "welcome" }, { ...context, access: { mode: "app", sections: ["kv"] } }),
        ])
        console.log(JSON.stringify(results))
      `,
      resolveDir: resolve("."),
    },
  })
  await Promise.all([...serverDirs, join(root, ".vitehub")].map(dir => rm(dir, { recursive: true })))
  const { stdout } = await promisify(execFile)(process.execPath, [output], { cwd: tmpdir() })
  const results: unknown = JSON.parse(stdout)
  expect(results).toMatchObject([
    { ok: true, value: { file: "app/server/emails/welcome.md", html: '<h1 id="hello-ada">Hello Ada</h1>', template: "welcome", text: "# Hello Ada" } },
    { ok: true, value: { file: "layer/server/emails/receipt.md", template: "receipt", text: "Receipt 42" } },
    { ok: false, code: "EMAIL_TEMPLATE_NOT_FOUND", status: 404, message: expect.stringContaining("Templates: welcome, receipt.") },
    { ok: false, code: "INTERNAL_R0023", status: 403 },
  ])
}, 30_000)
