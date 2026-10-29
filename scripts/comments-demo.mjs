#!/usr/bin/env node
// Builds the comments demo app once and serves it for a check in a real browser.
//
//   node scripts/comments-demo.mjs            build when needed, serve on http://127.0.0.1:4719/
//   node scripts/comments-demo.mjs --rebuild  build again first
//
// It needs the packages built: `corepack pnpm exec vp run --cache -t vite-hub#build`.
// It keeps running until you stop it (Ctrl+C). NODE_ENV=development gives the local identity, so there is no sign-in.
import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)))
const fixture = resolve(repository, "packages/vite-hub/test/fixtures/comments-demo")
const binary = resolve(repository, "packages/vite-hub/dist/bin.js")
const server = resolve(fixture, ".output/server/index.mjs")
const port = process.env.COMMENTS_DEMO_PORT ?? "4719"

if (!existsSync(binary)) {
  console.error("vite-hub is not built. Run: corepack pnpm exec vp run --cache -t vite-hub#build")
  process.exit(1)
}

const run = (command, args) => execFileSync(command, args, { cwd: fixture, env: { ...process.env, NODE_ENV: "production" }, stdio: "inherit" })

if (process.argv.includes("--rebuild") || !existsSync(server)) {
  console.log("Building the comments demo…")
  run(process.execPath, [binary, "db", "generate"])
  run(process.execPath, [binary, "db", "migrate"])
  // Vite resolves from the fixture, as the app would.
  run(process.execPath, ["--input-type=module", "-e", "const { createBuilder } = await import('vite'); await (await createBuilder({ logLevel: 'warn' })).buildApp()"])
}
else {
  console.log("Using the existing build. Pass --rebuild to build again.")
}

const child = spawn(process.execPath, [server], {
  cwd: fixture,
  env: { ...process.env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", NITRO_PORT: port, NODE_ENV: "development", PORT: port },
  stdio: "inherit",
})
console.log(`\nComments demo: http://127.0.0.1:${port}/  (and /about)\nPress Ctrl+C to stop.\n`)
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill())
child.on("exit", code => process.exit(code ?? 0))
