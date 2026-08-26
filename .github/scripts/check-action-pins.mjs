import { readdir, readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { isScalar, LineCounter, parseDocument, visit } from "yaml"

const actionCommitPattern = /^[^/@\s]+\/[^/@\s]+(?:\/[^/@\s]+)*@[0-9a-f]{40}$/
const versionCommentPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

async function findYamlFiles(directory, filter) {
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
    if (entry.isDirectory()) files.push(...await findYamlFiles(path, filter))
    else if (entry.isFile() && filter(entry.name)) files.push(path)
  }
  return files
}

export async function findGitHubActionPolicyFiles(repoRoot) {
  const githubRoot = resolve(repoRoot, ".github")
  const [workflows, actions] = await Promise.all([
    findYamlFiles(resolve(githubRoot, "workflows"), name => /\.ya?ml$/.test(name)),
    findYamlFiles(resolve(githubRoot, "actions"), name => /^action\.ya?ml$/.test(name)),
  ])
  return [...workflows, ...actions].sort()
}

export function inspectGitHubActionReferences(path, source) {
  const lineCounter = new LineCounter()
  const document = parseDocument(source, { lineCounter })
  const failures = document.errors.map(error => ({
    line: error.linePos?.[0]?.line ?? 1,
    message: `invalid YAML: ${error.message.split("\n", 1)[0]}`,
    path,
  }))

  if (failures.length > 0) return failures

  visit(document, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || pair.key.value !== "uses") return

      const line = lineCounter.linePos(pair.key.range?.[0] ?? 0).line
      if (!isScalar(pair.value) || typeof pair.value.value !== "string") {
        failures.push({ line, message: "uses must be a string", path })
        return
      }

      const reference = pair.value.value
      if (reference.startsWith("./")) return
      if (!actionCommitPattern.test(reference)) {
        failures.push({
          line,
          message: `external action must use a full 40-character commit SHA: ${reference}`,
          path,
        })
        return
      }

      const versionComment = pair.value.comment?.trim() ?? ""
      if (!versionCommentPattern.test(versionComment)) {
        failures.push({
          line,
          message: `pinned external action must have an exact version comment (for example, # v1.2.3): ${reference}`,
          path,
        })
      }
    },
  })

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
