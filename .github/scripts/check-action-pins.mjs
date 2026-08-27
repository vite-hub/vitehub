import { readdir, readFile, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml"

const actionCommitPattern = /^[^/@\s]+\/[^/@\s]+(?:\/[^/@\s]+)*@[0-9a-f]{40}$/
const versionCommentPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

async function findYamlFiles(directory, filter, ignoredDirectories = new Set()) {
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
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      files.push(...await findYamlFiles(path, filter, ignoredDirectories))
    }
    else if (filter(entry.name) && (entry.isFile() || (entry.isSymbolicLink() && (await stat(path)).isFile()))) {
      files.push(path)
    }
  }
  return files
}

export async function findGitHubActionPolicyFiles(repoRoot) {
  const githubRoot = resolve(repoRoot, ".github")
  const [workflows, actions] = await Promise.all([
    findYamlFiles(resolve(githubRoot, "workflows"), name => /\.ya?ml$/.test(name)),
    findYamlFiles(repoRoot, name => /^action\.ya?ml$/.test(name), new Set([".git", "node_modules"])),
  ])
  return [...new Set([...workflows, ...actions])].sort()
}

export function inspectGitHubActionReferences(path, source) {
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
    if (!isScalar(value) || typeof value.value !== "string") {
      failures.push({ line, message: "uses must be a string", path })
      return
    }

    const reference = value.value
    if (reference.startsWith("./")) return
    if (!actionCommitPattern.test(reference)) {
      failures.push({
        line,
        message: `external action must use a full 40-character commit SHA: ${reference}`,
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

  const findPair = (map, key) => map.items.find(pair => isScalar(pair.key) && pair.key.value === key)
  const inspectSteps = (steps) => {
    if (isAlias(steps)) steps = steps.resolve(document)
    if (!isSeq(steps)) return
    for (let step of steps.items) {
      if (isAlias(step)) step = step.resolve(document)
      if (isMap(step)) inspectUses(findPair(step, "uses"), step.comment ?? "")
    }
  }

  const root = document.contents
  if (!isMap(root)) return failures

  if (!/(?:^|\/)action\.ya?ml$/.test(normalizedPath) && normalizedPath.startsWith(".github/workflows/")) {
    const jobs = findPair(root, "jobs")?.value
    if (!isMap(jobs)) return failures
    for (const jobPair of jobs.items) {
      if (!isMap(jobPair.value)) continue
      inspectUses(findPair(jobPair.value, "uses"))
      inspectSteps(findPair(jobPair.value, "steps")?.value)
    }
  }
  else {
    const runs = findPair(root, "runs")?.value
    if (isMap(runs)) inspectSteps(findPair(runs, "steps")?.value)
  }

  return failures
}

export async function checkGitHubActionPins(repoRoot) {
  const files = await findGitHubActionPolicyFiles(repoRoot)
  if (files.length === 0) {
    return [{ line: 1, message: "no workflow or composite action YAML files found", path: ".github" }]
  }

  const failures = []
  for (const file of files) {
    const source = await readFile(file, "utf8")
    const path = relative(repoRoot, file)
    failures.push(...inspectGitHubActionReferences(path, source))
  }
  return failures
}

export async function runActionPinCheck(args, output = process) {
  if (args.length > 1) {
    output.stderr.write("Usage: node .github/scripts/check-action-pins.mjs [repo-root]\n")
    return 2
  }

  const repoRoot = resolve(args[0] ?? import.meta.dirname, args[0] ? "." : "../..")
  const failures = await checkGitHubActionPins(repoRoot)
  if (failures.length > 0) {
    for (const failure of failures) {
      output.stderr.write(`${failure.path}:${failure.line}: ${failure.message}\n`)
    }
    return 1
  }

  output.stdout.write("GitHub Action references are pinned.\n")
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runActionPinCheck(process.argv.slice(2))
}
