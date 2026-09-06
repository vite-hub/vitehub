#!/usr/bin/env node
import { spawn } from "node:child_process"
import { appendFile, readdir, readFile } from "node:fs/promises"
import { constants } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_MAX_PARALLEL = 2
const DEFAULT_PARALLEL_SAFE_PACKAGES = Object.freeze([
  "@vite-hub/env",
  "@vite-hub/markdown-template",
  "@vite-hub/runtime",
])

function parseList(value) {
  return value ? value.split(",").map(entry => entry.trim()).filter(Boolean) : []
}

function parseArguments(argv) {
  const [task, ...rest] = argv
  if (!task) throw new Error("Usage: node test/run-package-task.mjs <task> [options]")

  const options = {
    maxParallel: DEFAULT_MAX_PARALLEL,
    packageNames: undefined,
    parallelSafePackages: DEFAULT_PARALLEL_SAFE_PACKAGES,
    task,
    workspaceRoot: process.cwd(),
  }

  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!value) throw new Error(`Missing value for ${flag}`)
    if (flag === "--workspace") options.workspaceRoot = resolve(value)
    else if (flag === "--packages") options.packageNames = parseList(value)
    else if (flag === "--max-parallel") options.maxParallel = Number(value)
    else throw new Error(`Unknown option: ${flag}`)
  }

  if (!Number.isInteger(options.maxParallel) || options.maxParallel < 1 || options.maxParallel > 4) {
    throw new Error("--max-parallel must be an integer from 1 to 4")
  }
  return options
}

async function loadPackages(workspaceRoot) {
  const packagesDir = join(workspaceRoot, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packages = await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(async (entry) => {
      const dir = join(packagesDir, entry.name)
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
      return { dir, manifest, name: manifest.name }
    }))
  return packages.sort((left, right) => left.name.localeCompare(right.name))
}

function workspaceDependencies(pkg, packageByName) {
  return [
    ...Object.entries(pkg.manifest.dependencies ?? {}),
    ...Object.entries(pkg.manifest.devDependencies ?? {}),
    ...Object.entries(pkg.manifest.peerDependencies ?? {}),
  ]
    .filter(([name, version]) => packageByName.has(name) && String(version).startsWith("workspace:"))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right))
}

function selectPackages(packages, task, requestedNames) {
  const packageByName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const selectedNames = requestedNames?.length
    ? requestedNames
    : packages.filter(pkg => pkg.manifest.scripts?.[task]).map(pkg => pkg.name)

  for (const name of selectedNames) {
    if (!packageByName.has(name)) throw new Error(`Unknown workspace package: ${name}`)
    if (!packageByName.get(name).manifest.scripts?.[task]) throw new Error(`${name} does not define ${task}`)
  }

  return {
    packageByName,
    selected: selectedNames.map(name => packageByName.get(name)).sort((left, right) => left.name.localeCompare(right.name)),
  }
}

function buildClosure(selected, packageByName) {
  const names = new Set()
  function add(pkg) {
    if (names.has(pkg.name)) return
    names.add(pkg.name)
    for (const dependency of workspaceDependencies(pkg, packageByName)) add(packageByName.get(dependency))
  }
  for (const pkg of selected) add(pkg)
  return [...names]
    .map(name => packageByName.get(name))
    .filter(pkg => pkg.manifest.scripts?.build)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function signalExitCode(signal) {
  return 128 + (constants.signals[signal] ?? 0)
}

function executePackage(pkg, phase, options) {
  const packageScript = pkg.manifest.scripts?.[phase]
  if (phase === "test" && packageScript && /(?:^|&&\s*)vp test(?:\s|$)/.test(packageScript)) {
    return spawnCommand(join(options.workspaceRoot, "node_modules/.bin/vp"), ["test"], pkg.dir, options.signal)
  }
  if (phase === "test" && packageScript?.trim() === `vp run -t ${pkg.name}#build`) {
    return Promise.resolve({ code: 0, signal: undefined })
  }
  return spawnCommand("corepack", ["pnpm", "--dir", pkg.dir, "run", phase], options.workspaceRoot, options.signal)
}

function spawnCommand(command, args, cwd, abortSignal) {
  return new Promise((resolvePromise) => {
    const detached = process.platform !== "win32"
    const child = spawn(command, args, { cwd, detached, env: process.env, stdio: "inherit" })
    const onAbort = () => {
      const signal = abortSignal.reason || "SIGTERM"
      try {
        if (detached && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      }
      catch (error) {
        if (error.code !== "ESRCH") throw error
      }
    }
    if (abortSignal?.aborted) onAbort()
    else abortSignal?.addEventListener("abort", onAbort, { once: true })

    child.on("error", error => resolvePromise({ code: 1, error, signal: undefined }))
    child.on("close", (code, signal) => {
      abortSignal?.removeEventListener("abort", onAbort)
      resolvePromise({ code: signal ? signalExitCode(signal) : (code ?? 1), signal })
    })
  })
}

async function runPhase({ execute, maxParallel, packages, packageByName, parallelSafePackages, phase, priorResults, signal }) {
  const packageNames = new Set(packages.map(pkg => pkg.name))
  const pending = new Map(packages.map(pkg => [pkg.name, pkg]))
  const results = new Map()
  const safe = new Set(parallelSafePackages)
  const dependencies = new Map(packages.map(pkg => [
    pkg.name,
    workspaceDependencies(pkg, packageByName).filter(name => packageNames.has(name)),
  ]))

  while (pending.size > 0) {
    let changed = false
    for (const [name] of [...pending].sort(([left], [right]) => left.localeCompare(right))) {
      const blockedByPrior = priorResults?.get(name)
      const blockedDependency = dependencies.get(name).find((dependency) => {
        const result = results.get(dependency)
        return result?.status === "failed" || result?.status === "skipped"
      })
      const interrupted = signal.aborted ? String(signal.reason || "SIGTERM") : undefined
      if (blockedByPrior?.status === "failed" || blockedByPrior?.status === "skipped" || blockedDependency || interrupted) {
        const reason = interrupted
          ? `interrupted by ${interrupted}`
          : blockedByPrior?.status === "failed" || blockedByPrior?.status === "skipped"
            ? `${phase === "test" ? "build" : "prior task"} did not pass`
            : `dependency ${blockedDependency} did not pass`
        results.set(name, { reason, status: "skipped" })
        pending.delete(name)
        changed = true
      }
    }
    if (pending.size === 0) break

    const ready = [...pending.values()]
      .filter(pkg => dependencies.get(pkg.name).every(name => results.get(name)?.status === "passed"))
      .sort((left, right) => left.name.localeCompare(right.name))
    if (ready.length === 0) {
      if (changed) continue
      throw new Error(`Circular workspace dependency in ${phase} package graph`)
    }

    const safeReady = ready.filter(pkg => safe.has(pkg.name))
    const batch = safeReady.length > 0 ? safeReady.slice(0, maxParallel) : [ready[0]]

    for (const pkg of batch) {
      pending.delete(pkg.name)
      console.log(`\n[${phase}] ${pkg.name}`)
    }
    const completed = await Promise.all(batch.map(async (pkg) => {
      const outcome = await execute(pkg, phase, { signal })
      return [pkg.name, outcome]
    }))
    for (const [name, outcome] of completed) {
      results.set(name, outcome.code === 0
        ? { status: "passed" }
        : { code: outcome.code, error: outcome.error, signal: outcome.signal, status: "failed" })
    }
  }
  return results
}

function formatResult(result) {
  if (!result) return "not run"
  if (result.status === "passed") return "passed"
  if (result.status === "skipped") return `skipped: ${result.reason}`
  if (result.signal) return `failed (${result.signal})`
  return `failed (exit ${result.code})`
}

function packageStatus(build, task) {
  if (build?.status === "failed" || task?.status === "failed") return "FAIL"
  if (build?.status === "skipped" || task?.status === "skipped") return "SKIP"
  return "PASS"
}

function renderSummary(task, packages, buildResults, taskResults) {
  const rows = packages.map((pkg) => {
    const build = buildResults?.get(pkg.name)
    const result = taskResults.get(pkg.name)
    const status = packageStatus(build, result)
    const detail = task === "test"
      ? `build: ${formatResult(build)}, test: ${formatResult(result)}`
      : formatResult(result)
    return { build, detail, name: pkg.name, result, status }
  })

  const output = [`\nPackage task summary: ${task}`]
  for (const row of rows) output.push(`${row.status} ${row.name} (${row.detail})`)
  const failures = rows.filter(row => row.status === "FAIL")
  if (failures.length > 0) {
    output.push("", "Failures:")
    for (const row of failures) output.push(`- ${row.name}: ${row.detail}`)
  }

  const markdown = [`## Package task: ${task}`, "", "| Package | Build | Task |", "| --- | --- | --- |"]
  for (const row of rows) markdown.push(`| ${row.name} | ${formatResult(row.build)} | ${formatResult(row.result)} |`)
  markdown.push("")
  return { failures, markdown: markdown.join("\n"), output: output.join("\n") }
}

export async function runPackageTask(options) {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
  const packages = await loadPackages(workspaceRoot)
  const { packageByName, selected } = selectPackages(packages, options.task, options.packageNames)
  const controller = options.controller ?? new AbortController()
  const execute = options.execute ?? ((pkg, phase, executionOptions) => executePackage(pkg, phase, {
    ...executionOptions,
    workspaceRoot,
  }))
  let buildResults

  if (options.task === "test") {
    const buildPackages = buildClosure(selected, packageByName)
    buildResults = await runPhase({
      execute,
      maxParallel: options.maxParallel ?? DEFAULT_MAX_PARALLEL,
      packages: buildPackages,
      packageByName,
      parallelSafePackages: options.parallelSafePackages ?? DEFAULT_PARALLEL_SAFE_PACKAGES,
      phase: "build",
      signal: controller.signal,
    })
  }

  const taskResults = await runPhase({
    execute,
    maxParallel: options.maxParallel ?? DEFAULT_MAX_PARALLEL,
    packages: selected,
    packageByName,
    parallelSafePackages: options.parallelSafePackages ?? DEFAULT_PARALLEL_SAFE_PACKAGES,
    phase: options.task,
    priorResults: buildResults,
    signal: controller.signal,
  })
  const summaryPackages = packages.filter(pkg => buildResults?.has(pkg.name) || taskResults.has(pkg.name))
  const summary = renderSummary(options.task, summaryPackages, buildResults, taskResults)
  console.log(summary.output)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.markdown}\n`)

  const failedResults = [
    ...(buildResults?.values() ?? []),
    ...taskResults.values(),
  ].filter(result => result.status === "failed")
  let exitCode = 0
  if (controller.signal.aborted) exitCode = signalExitCode(String(controller.signal.reason || "SIGTERM"))
  else if (failedResults.length === 1) exitCode = failedResults[0].code ?? 1
  else if (failedResults.length > 1) exitCode = 1
  return { ...summary, exitCode }
}

async function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  }
  catch (error) {
    console.error(error.message)
    process.exitCode = 2
    return
  }

  const controller = new AbortController()
  const interrupt = signal => controller.abort(signal)
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    const result = await runPackageTask({ ...options, controller })
    process.exitCode = result.exitCode
  }
  catch (error) {
    console.error(error.stack || error.message)
    process.exitCode = 1
  }
  finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
