import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterEach, expect, it, vi } from "vitest"

import { addConsolePageToolRoutes } from "../src/console/nitro.ts"
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

/** The page tools route that Comments generates. `packages/comments/src/live-vite.ts` writes it. */
const commentsRouteFile = ".vitehub/nitro/comments/page-tools-route.mjs"

/**
 * Runs `no-route-middleware-api-security` on a Nuxt app with an auth route middleware, which turns the rule on, and
 * a Doctor manifest with the page tools routes of the Console and Comments, plus `extra` app handlers. Doctor reads
 * the file paths of `serverHandlers`, and the routes of `resolvedServerHandlers` when the manifest has them.
 */
async function middlewareSecurityReport(manifestKey: "serverHandlers" | "resolvedServerHandlers", extra: Array<{ route: string, file: string, text: string }> = []) {
  const root = mkdtempSync(join(tmpdir(), "vitehub-doctor-page-tools-"))
  roots.push(root)
  write(root, "package.json", JSON.stringify({ type: "module", dependencies: { "nuxt": "^5.0.0", "vite-hub": "*", "vue": "^3.5.0" } }))
  write(root, "nuxt.config.ts", "export default defineNuxtConfig({})\n")
  write(root, "app/middleware/auth.global.ts", "export default defineNuxtRouteMiddleware((to) => {\n  const session = useCookie(\"session\")\n  if (!session.value && to.path !== \"/login\") return navigateTo(\"/login\")\n})\n")
  const nitro: { handlers?: Array<{ handler: string, route?: string }>, publicAssets?: [] } = {}
  addConsolePageToolRoutes(nitro, join(root, "node_modules/vite-hub/dist/console/runtime"))
  const console = nitro.handlers ?? []
  const routes = [
    ...console.map(({ handler, route }) => ({ file: handler, route })),
    { file: join(root, commentsRouteFile), route: console[0]?.route },
  ]
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
  // The CLI is what apps run. It exits with 1 when it reports a warning, so read its JSON report from the error too.
  const cli = fileURLToPath(import.meta.resolve("vite-doctor/cli"))
  const args = [cli, root, "--framework", "nuxt", "--extends", "nuxt/strict", "--rules", "nuxt/middleware/no-route-middleware-api-security", "--no-cache", "--format", "json"]
  const stdout = await promisify(execFile)(process.execPath, args).then(({ stdout }) => stdout, (error: { stdout?: string }) => error.stdout ?? "")
  const report = JSON.parse(stdout) as { diagnostics: Array<{ location?: { path?: string } }> }
  return report.diagnostics.map(diagnostic => diagnostic.location?.path)
}

// The page tools route is public: it lists the tools that this visitor may use, and each tool checks access again on
// its own routes. Doctor takes a handler for an auth route when its path or file has a word such as `session`.
it.each(["serverHandlers", "resolvedServerHandlers"] as const)("lets Vite Doctor pass the page tools routes of the Console and Comments, from %s", async (manifestKey) => {
  // The control: an app route on an auth path without a guard.
  const unguarded = { route: "/api/admin/users", file: "server/api/admin/users.get.ts", text: "export default defineEventHandler(() => [])\n" }
  expect(await middlewareSecurityReport(manifestKey, [unguarded])).toEqual(["server/api/admin/users.get.ts"])
})
