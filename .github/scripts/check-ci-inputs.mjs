import { readdir, readFile, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml"

const actionCommitPattern = /^[^/@\s]+\/[^/@\s]+(?:\/[^/@\s]+)*@[0-9a-f]{40}$/
const dockerDigestPattern = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/
const exactPackagePattern = /^(?:@[^/@\s]+\/[^/@\s]+|[^/@\s]+)@(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|\$(?:\{[A-Z][A-Z0-9_]*\}|[A-Z][A-Z0-9_]*))$/
const versionCommentPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const shellOperatorPattern = /^(?:&&|\|\||;|\|)$/

function findExecutablePackageSpecs(command) {
  const specs = []
  for (const line of command.split("\n")) {
    if (line.trimStart().startsWith("#")) continue

    const tokens = [...line.matchAll(/"([^"]*)"|'([^']*)'|(&&|\|\||[;|])|([^\s;&|]+)/g)]
      .map(token => token[1] ?? token[2] ?? token[3] ?? token[4])
    for (let index = 0; index < tokens.length; index++) {
      let argumentsStart
      let npmExec = false
      const token = tokens[index]

      if (token === "npx" || token === "bunx") argumentsStart = index + 1
      else if (token === "npm" && tokens[index + 1] === "exec") {
        argumentsStart = index + 2
        npmExec = true
      }
      else if (token === "vp" || token === "pnpm" || token === "yarn") {
        let subcommand = index + 1
        while (tokens[subcommand]?.startsWith("-") && !shellOperatorPattern.test(tokens[subcommand])) subcommand++
        if (tokens[subcommand] !== "dlx") continue
        argumentsStart = subcommand + 1
      }
      else continue

      const end = tokens.findIndex((candidate, candidateIndex) => candidateIndex >= argumentsStart && shellOperatorPattern.test(candidate))
      const invocation = tokens.slice(argumentsStart, end === -1 ? tokens.length : end)
      let spec
      if (npmExec) {
        const packageOption = invocation.find(candidate => candidate.startsWith("--package=") || candidate.startsWith("-p="))
        spec = packageOption?.slice(packageOption.indexOf("=") + 1)
        if (!spec) {
          const packageOptionIndex = invocation.findIndex(candidate => candidate === "--package" || candidate === "-p")
          if (packageOptionIndex !== -1) spec = invocation[packageOptionIndex + 1]
        }
      }
      spec ??= invocation.find(candidate => candidate !== "--" && !candidate.startsWith("-"))
      specs.push(spec ?? "(missing)")
    }
  }
  return specs
}

function imageUsesLatest(reference) {
  const [nameAndTag, digest] = reference.split("@", 2)
  const lastSegment = nameAndTag.slice(nameAndTag.lastIndexOf("/") + 1)
  const hasTag = lastSegment.includes(":")
  const tag = hasTag ? lastSegment.slice(lastSegment.lastIndexOf(":") + 1) : "latest"
  return tag === "latest" && (hasTag || !digest)
}

async function findYamlFiles(directory, filter, ignoredDirectories = new Set(), recursive = true) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }

  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (recursive && entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      files.push(...await findYamlFiles(path, filter, ignoredDirectories))
    }
    else if (filter(entry.name) && (entry.isFile() || (entry.isSymbolicLink() && (await stat(path)).isFile()))) {
      files.push(path)
    }
  }
  return files
}

export async function findGitHubCIPolicyFiles(repoRoot) {
  const githubRoot = resolve(repoRoot, ".github")
  const [workflows, actions] = await Promise.all([
    findYamlFiles(resolve(githubRoot, "workflows"), name => /\.ya?ml$/.test(name), new Set(), false),
    findYamlFiles(repoRoot, name => /^action\.ya?ml$/.test(name), new Set([".git", "node_modules"])),
  ])
  return [...new Set([...workflows, ...actions])].sort()
}

export function inspectGitHubCIInputs(path, source) {
  const normalizedPath = path.replaceAll("\\", "/")
  const lineCounter = new LineCounter()
  const document = parseDocument(source, { lineCounter, schema: "failsafe" })
  const failures = document.errors.map(error => ({
    line: error.linePos?.[0]?.line ?? 1,
    message: `invalid YAML: ${error.message.split("\n", 1)[0]}`,
    path,
  }))

  if (failures.length > 0) return failures

  const inspectUses = (pair, enclosingComment = "") => {
    if (!pair) return

    const line = lineCounter.linePos(pair.key.range?.[0] ?? 0).line
    const value = isAlias(pair.value) ? pair.value.resolve(document) : pair.value
    if (!isScalar(value)) {
      failures.push({ line, message: "uses must be a string", path })
      return
    }

    const reference = value.value
    if (reference.startsWith("./")) return
    const isDockerReference = reference.startsWith("docker://")
    const isImmutable = isDockerReference
      ? dockerDigestPattern.test(reference)
      : actionCommitPattern.test(reference)
    if (!isImmutable) {
      failures.push({
        line,
        message: isDockerReference
          ? `Docker action must use a full SHA-256 digest: ${reference}`
          : `external action must use a full 40-character commit SHA: ${reference}`,
        path,
      })
      return
    }

    const versionComment = pair.value.comment?.trim() ?? enclosingComment.trim()
    if (!versionCommentPattern.test(versionComment)) {
      failures.push({
        line,
        message: `pinned external action must have an exact version comment (for example, # v1.2.3): ${reference}`,
        path,
      })
    }
  }

  const findPair = (map, key) => map.items.find((pair) => {
    const pairKey = isAlias(pair.key) ? pair.key.resolve(document) : pair.key
    return isScalar(pairKey) && pairKey.value === key
  })
  const inspectSteps = (steps) => {
    const sequenceComment = steps?.comment ?? ""
    if (isAlias(steps)) steps = steps.resolve(document)
    if (!isSeq(steps)) return
    const enclosingSequenceComment = steps.items.length === 1 ? sequenceComment : ""
    for (let step of steps.items) {
      const aliasComment = step?.comment ?? ""
      if (isAlias(step)) step = step.resolve(document)
      if (!isMap(step)) continue
      inspectUses(findPair(step, "uses"), aliasComment || step.comment || enclosingSequenceComment)
      const runPair = findPair(step, "run")
      if (!runPair) continue
      const line = lineCounter.linePos(runPair.key.range?.[0] ?? 0).line
      if (!isScalar(runPair.value) || typeof runPair.value.value !== "string") {
        failures.push({ line, message: "run must be a string", path })
        continue
      }
      for (const spec of findExecutablePackageSpecs(runPair.value.value)) {
        if (!exactPackagePattern.test(spec)) {
          failures.push({ line, message: `transient package executor must use an exact version: ${spec}`, path })
        }
      }
    }
  }

  const root = document.contents
  if (!isMap(root)) return failures

  const isDirectWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(normalizedPath)
  const isActionManifest = /(?:^|\/)action\.ya?ml$/.test(normalizedPath) && !isDirectWorkflow
  if (!isActionManifest && normalizedPath.startsWith(".github/workflows/")) {
    const jobs = findPair(root, "jobs")?.value
    if (!isMap(jobs)) return failures
    const enclosingJobsComment = jobs.items.length === 1 ? jobs.comment ?? "" : ""
    for (const jobPair of jobs.items) {
      const aliasComment = jobPair.value?.comment ?? ""
      const job = isAlias(jobPair.value) ? jobPair.value.resolve(document) : jobPair.value
      if (!isMap(job)) continue
      inspectUses(findPair(job, "uses"), aliasComment || job.comment || enclosingJobsComment)
      inspectSteps(findPair(job, "steps")?.value)
      for (const container of [findPair(job, "container")?.value, ...((findPair(job, "services")?.value?.items ?? []).map(pair => pair.value))]) {
        if (!isMap(container)) continue
        const imagePair = findPair(container, "image")
        if (!imagePair) continue
        const line = lineCounter.linePos(imagePair.key.range?.[0] ?? 0).line
        if (!isScalar(imagePair.value) || typeof imagePair.value.value !== "string") {
          failures.push({ line, message: "image must be a string", path })
        }
        else if (imageUsesLatest(imagePair.value.value)) {
          failures.push({ line, message: `container image must not use latest, explicitly or implicitly: ${imagePair.value.value}`, path })
        }
      }
    }
  }
  else {
    const runs = findPair(root, "runs")?.value
    if (isMap(runs)) inspectSteps(findPair(runs, "steps")?.value)
  }

  return failures
}

export async function checkGitHubCIInputs(repoRoot) {
  const files = await findGitHubCIPolicyFiles(repoRoot)
  if (files.length === 0) {
    return [{ line: 1, message: "no workflow or composite action YAML files found", path: ".github" }]
  }

  const failures = []
  for (const file of files) {
    const source = await readFile(file, "utf8")
    const path = relative(repoRoot, file)
    failures.push(...inspectGitHubCIInputs(path, source))
  }
  return failures
}

export async function runCIInputCheck(args, output = process) {
  if (args.length > 1) {
    output.stderr.write("Usage: node .github/scripts/check-ci-inputs.mjs [repo-root]\n")
    return 2
  }

  const repoRoot = resolve(args[0] ?? import.meta.dirname, args[0] ? "." : "../..")
  const failures = await checkGitHubCIInputs(repoRoot)
  if (failures.length > 0) {
    for (const failure of failures) {
      output.stderr.write(`${failure.path}:${failure.line}: ${failure.message}\n`)
    }
    return 1
  }

  output.stdout.write("GitHub CI inputs are pinned.\n")
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCIInputCheck(process.argv.slice(2))
}
