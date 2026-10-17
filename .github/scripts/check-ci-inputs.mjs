// zizmor and actionlint check the GitHub workflows in CI (see the
// workflow-lint job in .github/workflows/ci.yml). This script keeps only the
// two input rules that neither tool covers:
//
// 1. A transient package executor (npx, pnpm dlx, vp dlx, and so on) must name
//    an exact version. Without it, CI runs whatever version the registry
//    serves that day. zizmor's adhoc-packages audit does not read executors.
// 2. A `docker://` action must use a sha256 digest. zizmor's unpinned-uses
//    audit skips Docker references, and its regular persona accepts a tag.
//
// The scan reads plain command text. It does not model shell semantics, so it
// catches an accidental unpinned call, not a call that someone hides on purpose.
import { globSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { parse } from "yaml"

const policyFiles = [".github/workflows/*.{yml,yaml}", ".github/actions/**/action.{yml,yaml}"]
const exactPackage = /^(?:@[^/@\s]+\/)?[^/@\s]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const dockerDigest = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/
const executorCall = /(?:^|[\s;&|(`'\"])(?:npx|pnpx|bunx|bun\s+x|npm\s+(?:exec|x)|(?:pnpm|yarn|vp)\s+dlx)\s+([^\n;&|)`]*)/g
const variableReference = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g

function words(text) {
  return [...text.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map(([word]) => word.replace(/^(["'])(.*)\1$/, "$2"))
}

function packageSpecs(argumentsText) {
  const args = words(argumentsText)
  const specs = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--package" || argument === "-p") specs.push(args[++index] ?? "(missing)")
    else if (argument.startsWith("--package=")) specs.push(argument.slice("--package=".length))
    else if (argument === "--call" || argument === "-c") index++
  }
  if (specs.length > 0) return specs
  return [args.find(argument => !argument.startsWith("-")) ?? "(missing)"]
}

export function findUnpinnedExecutors(command, env = {}) {
  const expanded = command.replace(variableReference, (reference, braced, bare) => {
    const value = env[braced ?? bare]
    return value === undefined || value.includes("${{") ? reference : value
  })
  return [...expanded.matchAll(executorCall)]
    .flatMap(([, argumentsText]) => packageSpecs(argumentsText))
    .filter(spec => !exactPackage.test(spec))
}

export function inspectWorkflow(path, source) {
  const document = parse(source, { schema: "failsafe" }) ?? {}
  const jobs = document.runs?.steps
    ? [["composite action", { env: document.env, steps: document.runs.steps }]]
    : Object.entries(document.jobs ?? {})
  const failures = []
  for (const [jobName, job] of jobs) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      const where = `${path}: ${jobName} step ${step.name ?? index + 1}`
      if (step.uses?.startsWith("docker://") && !dockerDigest.test(step.uses)) {
        failures.push(`${where}: Docker action must use a sha256 digest: ${step.uses}`)
      }
      const env = { ...document.env, ...job.env, ...step.env }
      for (const command of [step.run, step.shell]) {
        if (!command) continue
        for (const spec of findUnpinnedExecutors(command, env)) {
          failures.push(`${where}: transient package executor must use an exact version: ${spec}`)
        }
      }
    }
  }
  return failures
}

export function checkGitHubCIInputs(repoRoot) {
  const files = globSync(policyFiles, { cwd: repoRoot }).sort()
  if (files.length === 0) return [`${repoRoot}: no workflow or composite action files found`]
  return files.flatMap(file => inspectWorkflow(file, readFileSync(resolve(repoRoot, file), "utf8")))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../.."))
  const failures = checkGitHubCIInputs(repoRoot)
  for (const failure of failures) console.error(failure)
  if (failures.length > 0) process.exitCode = 1
  else console.log("GitHub CI inputs are pinned.")
}
