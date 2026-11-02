#!/usr/bin/env node
// Builds the Nuxt lab with nuxt-safe-runtime-config, migrates a copy with the codemod, builds the copy with
// vite-hub/nuxt, and checks that both servers return the same typed values for the same NUXT_* variables.
// Run `corepack pnpm exec vp run --cache -t vite-hub#build` and `-t @vite-hub/codemods#build` first.
import { spawn, spawnSync } from "node:child_process"
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { deepStrictEqual, equal, ok } from "node:assert/strict"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
const lab = join(packageRoot, "examples/nuxt-safe-runtime-config")
const migrated = join(lab, ".migrated")
const nuxt = join(lab, "node_modules/nuxt/bin/nuxt.mjs")
const codemods = join(packageRoot, "dist/cli.js")
const secret = "e2e-synthetic-secret-value"
const variables = {
  NUXT_API_SECRET: secret,
  NUXT_MAX_RETRIES: "7",
  NUXT_FEATURE_ENABLED: "true",
  NUXT_PUBLIC_API_BASE: "https://override.example.com",
}

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith("NUXT_") || key.startsWith("VITEHUB_")) delete environment[key]
  }
  return { ...environment, ...extra }
}

function run(command, args, options) {
  console.log(`$ ${[command, ...args].join(" ")}${options.cwd ? `  (in ${options.cwd})` : ""}`)
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

async function serve(directory, port) {
  const child = spawn(process.execPath, [join(directory, ".output/server/index.mjs")], {
    cwd: directory,
    env: cleanEnvironment({ ...variables, PORT: String(port), HOST: "127.0.0.1" }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", chunk => output += chunk)
  child.stderr.on("data", chunk => output += chunk)
  try {
    const deadline = Date.now() + 30_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/config`)
        const page = await (await fetch(`http://127.0.0.1:${port}/`)).text()
        return { config: await response.json(), status: response.status, page }
      }
      catch (error) {
        if (Date.now() > deadline) throw new Error(`Server did not answer: ${error}\n${output}`)
        await new Promise(next => setTimeout(next, 300))
      }
    }
  }
  finally {
    child.kill("SIGTERM")
  }
}

async function outputText(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  return (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n")
}

await rm(migrated, { recursive: true, force: true })
await rm(join(lab, ".output"), { recursive: true, force: true })

console.log("1. Build and start the app with nuxt-safe-runtime-config.")
run(process.execPath, [nuxt, "build"], { cwd: lab, env: cleanEnvironment({ NUXT_PUBLIC_API_BASE: variables.NUXT_PUBLIC_API_BASE }) })
const before = await serve(lab, 4391)

console.log("2. Copy the app and run the codemod.")
for (const entry of await readdir(lab)) {
  if ([".migrated", ".nuxt", ".output", ".data", "node_modules"].includes(entry)) continue
  await cp(join(lab, entry), join(migrated, entry), { recursive: true })
}
const report = run(process.execPath, [codemods, "nuxt-safe-runtime-config", migrated], { cwd: packageRoot })
console.log(report)
ok(report.includes("server/api/config.get.ts:7 useServerEnv().apiSecret is secret"), "The report lists the secret read")

console.log("3. Type-check the migrated app. The secret read that the report lists fails until it is unsealed.")
const unsealed = spawnSync(process.execPath, [nuxt, "typecheck"], { cwd: migrated, encoding: "utf8", env: cleanEnvironment() })
const typeErrors = `${unsealed.stdout}${unsealed.stderr}`
ok(unsealed.status !== 0, "The migrated app must not type-check before the secret follow-up")
ok(typeErrors.includes("server/api/config.get.ts(10,36): error TS2339: Property 'length' does not exist on type 'SecretEnv<string>'."), typeErrors)
console.log(typeErrors.split("\n").filter(text => text.includes("error TS")).join("\n"))

console.log("4. Apply the reported follow-up: unseal the secret where the route needs its length.")
const route = join(migrated, "server/api/config.get.ts")
const routeCode = await readFile(route, "utf8")
ok(routeCode.includes("config.apiSecret.length"))
await writeFile(route, routeCode.replace("config.apiSecret.length", "config.apiSecret.unseal().length"))
run(process.execPath, [nuxt, "typecheck"], { cwd: migrated, env: cleanEnvironment() })

console.log("5. Build and start the migrated app with vite-hub/nuxt. Public Env is read during the build.")
run(process.execPath, [nuxt, "build"], { cwd: migrated, env: cleanEnvironment({ NUXT_PUBLIC_API_BASE: variables.NUXT_PUBLIC_API_BASE }) })
const after = await serve(migrated, 4392)

console.log("before:", JSON.stringify(before.config))
console.log("after: ", JSON.stringify(after.config))
equal(before.status, 200)
equal(after.status, 200)
deepStrictEqual(after.config, before.config)
deepStrictEqual(before.config, { apiBase: "https://override.example.com", featureEnabled: true, maxRetries: 7, secretLength: secret.length })
ok(before.page.includes("API base: https://override.example.com"), "The original page renders the public value")
ok(after.page.includes("API base: https://override.example.com"), "The migrated page renders the Public Env value")
ok(!(await outputText(join(migrated, ".output"))).includes(secret), "The migrated build output does not contain the secret")
console.log("The migrated app returns the same typed values.")
