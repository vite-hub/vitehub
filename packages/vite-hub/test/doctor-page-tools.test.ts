import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterEach, expect, it, vi } from "vitest"

import { doctorTestTimeout } from "./doctor-helpers.ts"

vi.setConfig({ testTimeout: doctorTestTimeout })

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}

const commentsRouteFile = ".vitehub/nitro/comments/page-tools-route.mjs"

async function middlewareSecurityReport(manifestKey: "serverHandlers" | "resolvedServerHandlers", extra: Array<{ route: string, file: string, text: string }> = []) {
  const root = mkdtempSync(join(tmpdir(), "vitehub-doctor-page-tools-"))
  roots.push(root)
  write(root, "package.json", JSON.stringify({ type: "module", dependencies: { "nuxt": "^5.0.0", "vite-hub": "*", "vue": "^3.5.0" } }))
  write(root, "nuxt.config.ts", "export default defineNuxtConfig({})\n")
  write(root, "app/middleware/auth.global.ts", "export default defineNuxtRouteMiddleware((to) => {\n  const session = useCookie(\"session\")\n  if (!session.value && to.path !== \"/login\") return navigateTo(\"/login\")\n})\n")
  const routes = [{ file: join(root, commentsRouteFile), route: "/_vitehub/page/tools" }]
  for (const { file } of routes) write(root, file.slice(root.length + 1), "export { viteHubPageSessionHandler as default } from \"@vite-hub/comments/runtime\"\n")
  for (const handler of extra) write(root, handler.file, handler.text)
  const handlers = [...routes, ...extra.map(({ file, route }) => ({ file: join(root, file), route }))]
  write(root, ".nuxt/doctor.manifest.json", JSON.stringify({
    nuxtVersion: "5.0.0",
    vueVersion: "3.5.0",
    compatibilityVersion: 5,
    generatedAt: new Date(Date.now() + 60_000).toISOString(),
    rootDir: root,
    srcDir: join(root, "app"),
    appDir: join(root, "app"),
    buildDir: join(root, ".nuxt"),
    autoImports: [],
    components: [],
    layers: [],
    aliases: {},
    routeRules: {},
    modules: [],
    serverHandlers: handlers,
    ...(manifestKey === "resolvedServerHandlers" ? { resolvedServerHandlers: handlers } : {}),
  }))
  const cli = fileURLToPath(import.meta.resolve("vite-doctor/cli"))
  const args = [cli, root, "--framework", "nuxt", "--extends", "nuxt/strict", "--rules", "nuxt/middleware/no-route-middleware-api-security", "--no-cache", "--format", "json"]
  const stdout = await promisify(execFile)(process.execPath, args).then(({ stdout }) => stdout, (error: { stdout?: string }) => error.stdout ?? "")
  const report = JSON.parse(stdout) as { diagnostics: Array<{ location?: { path?: string } }> }
  return report.diagnostics.map(diagnostic => diagnostic.location?.path)
}

it.each(["serverHandlers", "resolvedServerHandlers"] as const)("lets Vite Doctor pass the page tools route of Comments, from %s", async (manifestKey) => {
  const unguarded = { route: "/api/admin/users", file: "server/api/admin/users.get.ts", text: "export default defineEventHandler(() => [])\n" }
  expect(await middlewareSecurityReport(manifestKey, [unguarded])).toEqual(["server/api/admin/users.get.ts"])
})
