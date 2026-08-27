import { readdir, readFile, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml"

const actionCommitPattern = /^[^/@\s]+\/[^/@\s]+(?:\/[^/@\s]+)*@[0-9a-f]{40}$/
const dockerDigestPattern = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/
const exactPackagePattern = /^(?:@[^/@\s]+\/[^/@\s]+|[^/@\s]+)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const variablePackagePattern = /^((?:@[^/@\s]+\/[^/@\s]+|[^/@\s]+))@(?:\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*))$/
const versionCommentPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const shellOperatorPattern = /^(?:&&|\|\||;|\||\(|\)|`)$/
const packageExecutorValueOptions = new Set(["--cwd", "--dir", "--filter", "-C", "-F"])

function shellTokens(line) {
  const tokens = []
  for (const token of line.matchAll(/"([^"]*)"|'([^']*)'|(&&|\|\||[;|()`])|([^\s;&|()`]+)/g)) {
    const value = token[1] ?? token[2] ?? token[3] ?? token[4]
    tokens.push(value)
    if (token[1] === undefined) continue
    for (const substitution of token[1].matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
      tokens.push("(", ...shellTokens(substitution[1] ?? substitution[2]), ")")
    }
  }
  return tokens
}

function resolvePackageSpec(spec, environment) {
  const variable = variablePackagePattern.exec(spec)
  if (!variable) return spec
  return `${variable[1]}@${environment.get(variable[2] ?? variable[3]) ?? "(unresolved)"}`
}

function findExecutablePackageSpecs(command, inheritedEnvironment = new Map()) {
  const specs = []
  const environment = new Map(inheritedEnvironment)
  for (const line of command.split("\n")) {
    if (line.trimStart().startsWith("#")) continue

    const tokens = shellTokens(line)
    for (let index = 0; index < tokens.length; index++) {
      let argumentsStart
      let acceptsPackageOptions = false
      const token = tokens[index]
      const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(token)
      if (assignment) environment.set(assignment[1], assignment[2])

      if (token === "npx") {
        argumentsStart = index + 1
        acceptsPackageOptions = true
      }
      else if (token === "bunx" || token === "pnpx") argumentsStart = index + 1
      else if (token === "npm") {
        let subcommand = index + 1
        while (tokens[subcommand]?.startsWith("-") && !shellOperatorPattern.test(tokens[subcommand])) {
          const option = tokens[subcommand++]
          if (!option.includes("=")
            && tokens[subcommand] !== "exec" && tokens[subcommand] !== "x"
            && !tokens[subcommand]?.startsWith("-") && !shellOperatorPattern.test(tokens[subcommand])) {
            subcommand++
          }
        }
        if (tokens[subcommand] !== "exec" && tokens[subcommand] !== "x") continue
        argumentsStart = subcommand + 1
        acceptsPackageOptions = true
      }
      else if (token === "vp" || token === "pnpm" || token === "yarn") {
        let subcommand = index + 1
        while (tokens[subcommand]?.startsWith("-") && !shellOperatorPattern.test(tokens[subcommand])) {
          const option = tokens[subcommand++]
          if (packageExecutorValueOptions.has(option)) subcommand++
        }
        if (tokens[subcommand] !== "dlx") continue
        argumentsStart = subcommand + 1
      }
      else continue

      const end = tokens.findIndex((candidate, candidateIndex) => candidateIndex >= argumentsStart && shellOperatorPattern.test(candidate))
      const invocation = tokens.slice(argumentsStart, end === -1 ? tokens.length : end)
      const packageSpecs = []
      if (acceptsPackageOptions) {
        for (let argumentIndex = 0; argumentIndex < invocation.length; argumentIndex++) {
          const argument = invocation[argumentIndex]
          if (argument === "--") break
          if (argument.startsWith("--package=") || argument.startsWith("-p=")) {
            packageSpecs.push(argument.slice(argument.indexOf("=") + 1))
          }
          else if (argument === "--package" || argument === "-p") {
            packageSpecs.push(invocation[++argumentIndex] ?? "(missing)")
          }
        }
      }
      if (packageSpecs.length === 0) {
        packageSpecs.push(invocation.find(candidate => candidate !== "--" && !candidate.startsWith("-")) ?? "(missing)")
      }
      specs.push(...packageSpecs.map(spec => resolvePackageSpec(spec, environment)))
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
  const environmentWith = (inherited, value) => {
    const environment = new Map(inherited)
    if (isAlias(value)) value = value.resolve(document)
    if (!isMap(value)) return environment
    for (const pair of value.items) {
      const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key
      const entry = isAlias(pair.value) ? pair.value.resolve(document) : pair.value
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow YAML is untrusted input at this policy boundary.
      if (isScalar(key) && isScalar(entry) && typeof entry.value === "string") {
        environment.set(key.value, entry.value)
      }
    }
    return environment
  }
  const inspectSteps = (steps, inheritedEnvironment = new Map()) => {
    const sequenceComment = steps?.comment ?? ""
    if (isAlias(steps)) steps = steps.resolve(document)
    if (!isSeq(steps)) return
    const enclosingSequenceComment = steps.items.length === 1 ? sequenceComment : ""
    for (let step of steps.items) {
      const aliasComment = step?.comment ?? ""
      if (isAlias(step)) step = step.resolve(document)
      if (!isMap(step)) continue
      inspectUses(findPair(step, "uses"), aliasComment || step.comment || enclosingSequenceComment)
      const environment = environmentWith(inheritedEnvironment, findPair(step, "env")?.value)
      const shellPair = findPair(step, "shell")
      if (shellPair) {
        const shell = isAlias(shellPair.value) ? shellPair.value.resolve(document) : shellPair.value
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow YAML is untrusted input at this policy boundary.
        if (isScalar(shell) && typeof shell.value === "string") {
          const line = lineCounter.linePos(shellPair.key.range?.[0] ?? 0).line
          for (const spec of findExecutablePackageSpecs(shell.value, environment)) {
            if (!exactPackagePattern.test(spec)) {
              failures.push({ line, message: `transient package executor must use an exact version: ${spec}`, path })
            }
          }
        }
      }
      const runPair = findPair(step, "run")
      if (!runPair) continue
      const line = lineCounter.linePos(runPair.key.range?.[0] ?? 0).line
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow YAML is untrusted input at this policy boundary.
      if (!isScalar(runPair.value) || typeof runPair.value.value !== "string") {
        failures.push({ line, message: "run must be a string", path })
        continue
      }
      for (const spec of findExecutablePackageSpecs(runPair.value.value, environment)) {
        if (!exactPackagePattern.test(spec)) {
          failures.push({ line, message: `transient package executor must use an exact version: ${spec}`, path })
        }
      }
    }
  }

  const root = document.contents
  if (!isMap(root)) return failures
  const workflowEnvironment = environmentWith(new Map(), findPair(root, "env")?.value)

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
      const jobEnvironment = environmentWith(workflowEnvironment, findPair(job, "env")?.value)
      inspectSteps(findPair(job, "steps")?.value, jobEnvironment)
      let services = findPair(job, "services")?.value
      if (isAlias(services)) services = services.resolve(document)
      const serviceContainers = isMap(services) ? services.items.map(pair => pair.value) : []
      for (let container of [findPair(job, "container")?.value, ...serviceContainers]) {
        if (isAlias(container)) container = container.resolve(document)
        if (isScalar(container)) {
          const line = lineCounter.linePos(container.range?.[0] ?? 0).line
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow YAML is untrusted input at this policy boundary.
          if (typeof container.value !== "string") {
            failures.push({ line, message: "image must be a string", path })
          }
          else if (imageUsesLatest(container.value)) {
            failures.push({ line, message: `container image must not use latest, explicitly or implicitly: ${container.value}`, path })
          }
          continue
        }
        if (!isMap(container)) continue
        const imagePair = findPair(container, "image")
        if (!imagePair) continue
        const line = lineCounter.linePos(imagePair.key.range?.[0] ?? 0).line
        const image = isAlias(imagePair.value) ? imagePair.value.resolve(document) : imagePair.value
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow YAML is untrusted input at this policy boundary.
        if (!isScalar(image) || typeof image.value !== "string") {
          failures.push({ line, message: "image must be a string", path })
        }
        else if (imageUsesLatest(image.value)) {
          failures.push({ line, message: `container image must not use latest, explicitly or implicitly: ${image.value}`, path })
        }
      }
    }
  }
  else {
    const runs = findPair(root, "runs")?.value
    if (isMap(runs)) inspectSteps(findPair(runs, "steps")?.value, workflowEnvironment)
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
