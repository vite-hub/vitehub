#!/usr/bin/env node
// Runs the migration on open source Nuxt apps pinned in projects.json. It is not part of `vp test`: it clones
// repositories and installs their dependencies, so run it by hand after `vp run -t @vite-hub/codemods#build`.
//
//   node packages/codemods/test/real-world/run.mjs [--build] [id...]
//
// Without --build it installs each app at its pinned commit, runs the migration, and checks which codemods ran and
// which follow-ups they reported. With --build it also moves the app to Nuxt 5 nightly with the local vite-hub
// checkout, builds it, starts the server, and checks the probes. Apps live outside the repository, in
// $VITEHUB_REAL_WORLD_DIR or the system temp folder, so Node cannot resolve packages from the workspace.
// $VITEHUB_REAL_WORLD_WRAP prefixes install and build commands, for example `heavy`.
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const packageRoot = resolve(here, "../..")
const repositoryRoot = resolve(packageRoot, "../..")
const viteHub = join(repositoryRoot, "packages/vite-hub")
const nightly = "npm:nuxt-nightly@5.0.0-2611070044-e3875e8"
const workRoot = process.env.VITEHUB_REAL_WORLD_DIR ?? join(tmpdir(), "vitehub-real-world")
const wrap = process.env.VITEHUB_REAL_WORLD_WRAP?.split(" ").filter(Boolean) ?? []
const args = process.argv.slice(2)
const build = args.includes("--build")
const only = args.filter(arg => !arg.startsWith("--"))
const projects = JSON.parse(await readFile(join(here, "projects.json"), "utf8"))
const { runMigration, formatMigrationReport } = await import(join(packageRoot, "dist/index.js"))

function run(command, commandArgs, options = {}) {
  const full = [...wrap, command, ...commandArgs]
  const result = spawnSync(full[0], full.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", ...options.env }, cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${full.join(" ")} failed in ${options.cwd}\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`)
  return result
}

const installers = {
  pnpm: frozen => ["corepack", ["pnpm", "install", frozen ? "--frozen-lockfile" : "--no-frozen-lockfile", "--ignore-scripts"]],
  bun: () => ["npx", ["-y", "bun", "install", "--ignore-scripts"]],
  npm: () => ["npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]],
}

async function checkout(project) {
  const root = join(workRoot, project.id)
  if (!existsSync(join(root, ".git"))) {
    await mkdir(root, { recursive: true })
    run("git", ["init", "-q"], { cwd: root })
    run("git", ["remote", "add", "origin", `https://github.com/${project.repo}.git`], { cwd: root })
  }
  run("git", ["fetch", "-q", "--depth", "1", "origin", project.commit], { cwd: root })
  run("git", ["checkout", "-q", "--force", "FETCH_HEAD"], { cwd: root })
  run("git", ["clean", "-qfdx", "-e", "node_modules"], { cwd: root })
  return root
}

async function serve(app, port, probes, env) {
  const child = spawn(process.execPath, [join(app, ".output/server/index.mjs")], { cwd: app, env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", chunk => log += chunk)
  child.stderr.on("data", chunk => log += chunk)
  try {
    const deadline = Date.now() + 40_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`The server exited early:\n${log}`)
      try {
        await fetch(`http://127.0.0.1:${port}/`)
        break
      }
      catch {
        if (Date.now() > deadline) throw new Error(`The server did not answer:\n${log}`)
        await new Promise(next => setTimeout(next, 300))
      }
    }
    const failures = []
    for (const probe of probes) {
      const response = await fetch(`http://127.0.0.1:${port}${probe.path}`, { method: probe.method ?? "GET" })
      const body = await response.text()
      const ok = response.status === probe.status && (!probe.contains || body.includes(probe.contains))
      console.log(`  ${ok ? "ok" : "FAIL"} ${probe.method ?? "GET"} ${probe.path} -> ${response.status} ${body.replace(/\s+/g, " ").slice(0, 160)}`)
      if (!ok) failures.push(`${probe.path}: expected ${probe.status}${probe.contains ? ` with "${probe.contains}"` : ""}, got ${response.status}`)
    }
    if (failures.length) throw new Error(`${failures.join("\n")}\n--- server log ---\n${log.slice(-4000)}`)
  }
  finally {
    child.kill("SIGTERM")
  }
}

let failed = 0
for (const project of projects.filter(entry => !only.length || only.includes(entry.id))) {
  console.log(`\n${project.id} (${project.repo}@${project.commit.slice(0, 7)})`)
  try {
    const root = await checkout(project)
    const app = join(root, project.dir ?? ".")
    // Codemods that load schemas need the app's packages. The others read source only.
    if (project.install) {
      const [command, commandArgs] = installers[project.install](true)
      if (run(command, commandArgs, { cwd: root, allowFailure: true }).status !== 0) {
        const [fallback, fallbackArgs] = installers[project.install](false)
        run(fallback, fallbackArgs, { cwd: root })
      }
    }

    const migration = await runMigration({ cwd: app })
    const report = formatMigrationReport(migration)
    await writeFile(join(workRoot, `${project.id}.report.txt`), report)
    const ran = migration.steps.map(step => `${step.codemod.name}${step.error ? " (error)" : ""}`)
    console.log(`  codemods: ${ran.join(", ") || "none"}; files: ${migration.edits.length}; follow-ups: ${migration.steps.reduce((count, step) => count + (step.result?.followUps.length ?? 0), 0)}`)
    const expected = project.expect.codemods
    if (JSON.stringify(ran) !== JSON.stringify(expected)) throw new Error(`Expected codemods ${JSON.stringify(expected)}, got ${JSON.stringify(ran)}.\n${report}`)
    for (const text of project.expect.report ?? []) {
      if (!report.includes(text)) throw new Error(`The report does not contain "${text}".\n${report}`)
    }

    if (build && project.build) {
      const manifestPath = join(app, "package.json")
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
      for (const section of ["dependencies", "devDependencies"]) {
        if (manifest[section]?.nuxt) manifest[section].nuxt = nightly
        if (manifest[section]?.["vite-hub"]) manifest[section]["vite-hub"] = `link:${viteHub}`
      }
      manifest.pnpm = { ...manifest.pnpm, overrides: { ...manifest.pnpm?.overrides, nuxt: nightly } }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      const [installCommand, installArgs] = installers[project.install || "pnpm"](false)
      run(installCommand, installArgs, { cwd: root })
      const nuxt = join(app, "node_modules/nuxt/bin/nuxt.mjs")
      const env = project.build.env ?? {}
      if (project.build.typecheck) run(process.execPath, [nuxt, "typecheck"], { cwd: app, env })
      run(process.execPath, [nuxt, "build"], { cwd: app, env })
      console.log("  built with Nuxt 5 nightly and the local vite-hub")
      await serve(app, project.build.port ?? 4810, project.build.probes ?? [], env)
    }
  }
  catch (error) {
    failed++
    console.log(`  FAIL ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(failed ? `\n${failed} project(s) failed.` : "\nAll projects passed.")
process.exitCode = failed ? 1 : 0
