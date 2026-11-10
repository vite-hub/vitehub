#!/usr/bin/env node
// Serves the comments demo app with the Vite dev server for a check in a real browser.
//
//   node scripts/comments-demo.mjs            serve on http://127.0.0.1:4719/
//
// It needs the packages built: `corepack pnpm exec vp run --cache -t vite-hub#build`.
// It keeps running until you stop it (Ctrl+C). `vite dev` gives the local identity, so there is no sign-in.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)))
const fixture = resolve(repository, "packages/vite-hub/test/fixtures/comments-demo")
const binary = resolve(repository, "packages/vite-hub/dist/bin.js")
const port = Number(process.env.COMMENTS_DEMO_PORT ?? "4719")

if (!existsSync(binary)) {
  console.error("vite-hub is not built. Run: corepack pnpm exec vp run --cache -t vite-hub#build")
  process.exit(1)
}

const run = (command, args) => execFileSync(command, args, { cwd: fixture, stdio: "inherit" })

run(process.execPath, [binary, "db", "generate"])
run(process.execPath, [binary, "db", "migrate"])
// Vite resolves from the fixture, as the app would.
process.chdir(fixture)
const { createServer } = await import("vite")
const server = await createServer({ logLevel: "warn", root: fixture, server: { host: "127.0.0.1", port, strictPort: true } })
await server.listen()
console.log(`\nComments demo: http://127.0.0.1:${port}/  (and /about)\nPress Ctrl+C to stop.\n`)
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void server.close().then(() => process.exit(0)))
