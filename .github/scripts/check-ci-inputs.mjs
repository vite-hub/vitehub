import { readdir, readFile, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml"

const actionCommitPattern = /^[^/@\s]+\/[^/@\s]+(?:\/[^/@\s]+)*@[0-9a-f]{40}$/
const dockerDigestPattern = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/
const exactPackagePattern = /^(?:@[^/@\s]+\/[^/@\s]+|[^/@\s]+)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const variablePackagePattern = /^((?:@[^/@\s]+\/[^/@\s]+|[^/@\s]+))@(?:\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*))$/
const versionCommentPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const shellOperatorPattern = /^(?:&&|\|\||[;&|]|\$\(|\(|\)|`|\{|\})$/
const packageExecutorValueOptions = new Set(["--cwd", "--dir", "--filter", "-C", "-F"])
const shellCommands = new Set(["bash", "dash", "ksh", "sh", "zsh"])
const shellCommandPrefixes = new Set(["!", "do", "elif", "else", "if", "then", "until", "while"])
const envValueOptions = new Set(["--chdir", "--unset", "-C", "-u"])
const envSplitStringOptions = new Set(["--split-string", "-S"])
const commandValueOptions = new Set(["--argv0", "-a"])
const commandQueryOptions = new Set(["--verbose", "-V", "-v"])
const sudoQueryOptions = new Set(["--list", "-l"])
const sudoValueOptions = new Set([
  "--chdir", "--chroot", "--close-from", "--command-timeout", "--group", "--host", "--prompt", "--role", "--type", "--user",
  "-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-u",
])
const sudoShortValueOptions = new Set([...sudoValueOptions]
  .filter(option => /^-[^-]$/.test(option))
  .map(option => option.slice(1)))
const timeoutValueOptions = new Set(["--kill-after", "--signal", "-k", "-s"])
const assignmentPattern = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const redirectionPattern = /^(?:\d*|&)?(?:>>?|<<?|<>|>&|<&|>\|)(?:.*)$/

function shellTokens(line) {
  const tokens = []
  let previousEnd = -1
  let wordIndex
  for (const token of line.matchAll(/"([^"]*)"|'([^']*)'|(\$\{[^}]*\})|(\d*(?:>&|<&)(?:\d+|-)|\$\(|&&|\|\||[;&|()`{}])|([^\s;&|()`{}"']+)/g)) {
    if (token.index !== previousEnd) wordIndex = undefined
    previousEnd = token.index + token[0].length
    if (token[5]?.startsWith("#")
      && (token.index === 0 || /[\s;&|()`]/.test(line[token.index - 1]))) break
    const value = token[1] ?? token[2] ?? token[3] ?? token[4] ?? token[5]
    if (token[4] !== undefined) {
      tokens.push(value)
      wordIndex = undefined
    }
    else if (wordIndex === undefined) {
      wordIndex = tokens.length
      tokens.push(value)
    }
    else {
      tokens[wordIndex] += value
    }
    if (token[3] !== undefined) {
      for (const substitution of token[3].matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
        tokens.push("$(", ...shellTokens(substitution[1] ?? substitution[2]), ")")
      }
    }
    if (token[1] === undefined) continue
    for (const substitution of token[1].matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
      tokens.push("$(", ...shellTokens(substitution[1] ?? substitution[2]), ")")
    }
  }
  return tokens
}

function commandIndexes(tokens) {
  const indexes = []
  let commandStart = true
  let commandOptions = false
  const groups = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === "$(") {
      groups.push({ restore: commandStart, substitution: true })
      commandStart = true
      commandOptions = false
    }
    else if (token === "(" || token === "{") {
      groups.push({ restore: false, substitution: false })
      commandStart = true
      commandOptions = false
    }
    else if (token === ")" || token === "}") {
      const group = groups.pop()
      commandStart = group?.substitution ? group.restore : group ? false : true
      commandOptions = false
    }
    else if (shellOperatorPattern.test(token)) {
      commandStart = true
      commandOptions = false
    }
    else if (commandStart && token === "time") {
      commandOptions = true
      continue
    }
    else if (commandStart && commandOptions && token.startsWith("-")) {
      continue
    }
    else if (commandStart && shellCommandPrefixes.has(token)) {
      continue
    }
    else if (commandStart && redirectionPattern.test(token)) {
      continue
    }
    else if (commandStart && !assignmentPattern.test(token)) {
      let executableIndex = index
      while (executableIndex < tokens.length) {
        const wrapper = executableName(tokens[executableIndex])
        if (wrapper === "command" || wrapper === "exec") {
          executableIndex++
          let queriesOnly = false
          while (executableIndex < tokens.length) {
            const argument = tokens[executableIndex]
            if (argument === "--") {
              executableIndex++
              break
            }
            if (wrapper === "command" && commandQueryOptions.has(argument)) {
              queriesOnly = true
              executableIndex++
              continue
            }
            if (commandValueOptions.has(argument)) executableIndex += 2
            else if (argument.startsWith("-")) executableIndex++
            else break
          }
          if (queriesOnly) executableIndex = tokens.length
          continue
        }
        if (wrapper === "sudo") {
          executableIndex++
          let queriesOnly = false
          while (executableIndex < tokens.length) {
            const argument = tokens[executableIndex]
            if (argument === "--") {
              executableIndex++
              break
            }
            if (isSudoQueryOption(argument)) {
              queriesOnly = true
              executableIndex++
              continue
            }
            if (assignmentPattern.test(argument)) executableIndex++
            else if (sudoValueOptions.has(argument)) executableIndex += 2
            else if (argument.startsWith("-")) executableIndex++
            else break
          }
          if (queriesOnly) executableIndex = tokens.length
          continue
        }
        if (wrapper === "timeout") {
          executableIndex++
          while (executableIndex < tokens.length) {
            const argument = tokens[executableIndex]
            if (argument === "--") {
              executableIndex++
              break
            }
            if (isTimeoutValueOption(argument)) executableIndex += 2
            else if (argument.startsWith("-")) executableIndex++
            else break
          }
          if (executableIndex < tokens.length) executableIndex++
          continue
        }
        if (wrapper !== "env") break
        executableIndex++
        while (executableIndex < tokens.length) {
          const argument = tokens[executableIndex]
          if (argument === "--") {
            executableIndex++
            break
          }
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) executableIndex++
          else if (envSplitStringOptions.has(argument)) {
            tokens.splice(executableIndex, 2, ...shellTokens(tokens[executableIndex + 1] ?? ""))
          }
          else if (argument.startsWith("--split-string=")) {
            tokens.splice(executableIndex, 1, ...shellTokens(argument.slice("--split-string=".length)))
          }
          else if (/^-S.+/.test(argument)) {
            tokens.splice(executableIndex, 1, ...shellTokens(argument.slice(2)))
          }
          else if (envValueOptions.has(argument)) executableIndex += 2
          else if (argument.startsWith("-")) executableIndex++
          else break
        }
      }
      if (executableIndex < tokens.length && !shellOperatorPattern.test(tokens[executableIndex])) {
        indexes.push(executableIndex)
      }
      commandStart = false
      commandOptions = false
    }
  }
  return indexes
}

function executableName(token) {
  return token.slice(token.lastIndexOf("/") + 1)
}

function isSudoQueryOption(argument) {
  if (sudoQueryOptions.has(argument)) return true
  if (!/^-[^-]+$/.test(argument)) return false
  for (const option of argument.slice(1)) {
    if (option === "l") return true
    if (sudoShortValueOptions.has(option)) return false
  }
  return false
}

function isTimeoutValueOption(argument) {
  if (timeoutValueOptions.has(argument)) return true
  if (!argument.startsWith("--") || argument.includes("=")) return false
  return ["--kill-after", "--signal"].some(option => option.startsWith(argument))
}

function isShellCommand(token) {
  return shellCommands.has(executableName(token))
}

function resolvePackageSpec(spec, environment) {
  const variable = variablePackagePattern.exec(spec)
  if (!variable) return spec
  return `${variable[1]}@${environment.get(variable[2] ?? variable[3]) ?? "(unresolved)"}`
}

function conditionalCounts(tokens) {
  const groups = []
  let closes = 0
  let opens = 0
  for (const token of tokens) {
    if (token === "$(") {
      groups.push("substitution")
      continue
    }
    if (token === "(") {
      if (!groups.includes("substitution")) opens++
      groups.push("group")
      continue
    }
    if (token === ")") {
      const group = groups.pop()
      if (group !== "substitution" && !groups.includes("substitution")) closes++
      continue
    }
    if (groups.includes("substitution")) continue
    if (token === "fi" || token === "done" || token === "esac") closes++
    else if (token === "if" || token === "while" || token === "until" || token === "for" || token === "select" || token === "case") opens++
  }
  return { closes, opens }
}

function findExecutablePackageSpecs(command, inheritedEnvironment = new Map()) {
  const specs = []
  const environment = new Map(inheritedEnvironment)
  let dataHereDocument
  let conditionalDepth = 0
  for (const line of command.replaceAll(/\\\r?\n/g, "").split("\n")) {
    if (dataHereDocument) {
      if (line.trim() === dataHereDocument.delimiter) dataHereDocument = undefined
      else if (dataHereDocument.expand) {
        for (const substitution of line.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
          specs.push(...findExecutablePackageSpecs(substitution[1] ?? substitution[2], environment))
        }
      }
      continue
    }
    if (line.trimStart().startsWith("#")) continue

    const tokens = shellTokens(line)
    const executableIndexes = commandIndexes(tokens)
    const { closes: closesConditional, opens: opensConditional } = conditionalCounts(tokens)
    const activeConditionalDepth = Math.max(0, conditionalDepth - closesConditional)
    if (executableIndexes.length === 0 && activeConditionalDepth === 0 && opensConditional === 0
      && tokens.length > 0 && tokens.every(token => assignmentPattern.test(token))) {
      for (const token of tokens) {
        const assignment = assignmentPattern.exec(token)
        environment.set(assignment[1], assignment[2])
      }
    }
    for (const index of executableIndexes) {
      if (activeConditionalDepth > 0 || opensConditional > 0 || executableName(tokens[index]) !== "export") continue
      for (const token of tokens.slice(index + 1)) {
        if (shellOperatorPattern.test(token)) break
        if (token === "--" || token.startsWith("-")) continue
        const assignment = assignmentPattern.exec(token)
        if (assignment) environment.set(assignment[1], assignment[2])
      }
    }
    const hereDocument = /(?:^|\s)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (hereDocument && !executableIndexes.some(index => isShellCommand(tokens[index]))) {
      dataHereDocument = { delimiter: hereDocument[2], expand: hereDocument[1] === "" }
    }
    for (const index of executableIndexes) {
      let argumentsStart
      let acceptsPackageOptions = false
      const token = tokens[index]
      const executable = executableName(token)

      if (executable === "eval") {
        const end = tokens.findIndex((candidate, candidateIndex) => candidateIndex > index && shellOperatorPattern.test(candidate))
        const sourceStart = tokens[index + 1] === "--" ? index + 2 : index + 1
        const source = tokens.slice(sourceStart, end === -1 ? tokens.length : end).join(" ")
        if (source) specs.push(...findExecutablePackageSpecs(source, environment))
        continue
      }

      if (isShellCommand(token)) {
        const end = tokens.findIndex((candidate, candidateIndex) => candidateIndex > index && shellOperatorPattern.test(candidate))
        const invocation = tokens.slice(index + 1, end === -1 ? tokens.length : end)
        const callIndex = invocation.findIndex(argument => /^-[^-]*c/.test(argument))
        const commandIndex = callIndex + (invocation[callIndex + 1] === "--" ? 2 : 1)
        if (callIndex !== -1 && invocation[commandIndex]) {
          specs.push(...findExecutablePackageSpecs(invocation[commandIndex], environment))
        }
        for (let argumentIndex = 0; argumentIndex < invocation.length; argumentIndex++) {
          const argument = invocation[argumentIndex]
          const source = argument === "<<<" ? invocation[++argumentIndex] : argument.startsWith("<<<") ? argument.slice(3) : undefined
          if (source) specs.push(...findExecutablePackageSpecs(source, environment))
        }
        continue
      }

      if (executable === "npx") {
        argumentsStart = index + 1
        acceptsPackageOptions = true
      }
      else if (executable === "bunx" || executable === "pnpx") argumentsStart = index + 1
      else if (executable === "bun" && tokens[index + 1] === "x") argumentsStart = index + 2
      else if (executable === "npm") {
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
      else if (executable === "vp" || executable === "pnpm" || executable === "yarn") {
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
      const callCommands = []
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
          else if (argument.startsWith("--call=")) {
            callCommands.push(argument.slice(argument.indexOf("=") + 1))
          }
          else if (argument === "--call" || argument === "-c") {
            callCommands.push(invocation[++argumentIndex] ?? "")
          }
        }
      }
      if (packageSpecs.length === 0 && callCommands.length === 0) {
        packageSpecs.push(invocation.find(candidate => candidate !== "--" && !candidate.startsWith("-")) ?? "(missing)")
      }
      specs.push(...packageSpecs.map(spec => resolvePackageSpec(spec, environment)))
      for (const callCommand of callCommands) {
        specs.push(...findExecutablePackageSpecs(callCommand, environment))
      }
    }
    conditionalDepth = Math.max(0, conditionalDepth + opensConditional - closesConditional)
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

function imageIsMutable(reference) {
  return reference.includes("${{") || imageUsesLatest(reference)
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
  const defaultRunShell = (map, inherited) => {
    let defaults = findPair(map, "defaults")?.value
    if (isAlias(defaults)) defaults = defaults.resolve(document)
    if (!isMap(defaults)) return inherited
    let run = findPair(defaults, "run")?.value
    if (isAlias(run)) run = run.resolve(document)
    return isMap(run) ? findPair(run, "shell") ?? inherited : inherited
  }
  const inspectSteps = (steps, inheritedEnvironment = new Map(), inheritedShell) => {
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
      const runPair = findPair(step, "run")
      if (!runPair) continue
      const shellPair = findPair(step, "shell") ?? inheritedShell
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
      const line = lineCounter.linePos(runPair.key.range?.[0] ?? 0).line
      const run = isAlias(runPair.value) ? runPair.value.resolve(document) : runPair.value
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow YAML is untrusted input at this policy boundary.
      if (!isScalar(run) || typeof run.value !== "string") {
        failures.push({ line, message: "run must be a string", path })
        continue
      }
      for (const spec of findExecutablePackageSpecs(run.value, environment)) {
        if (!exactPackagePattern.test(spec)) {
          failures.push({ line, message: `transient package executor must use an exact version: ${spec}`, path })
        }
      }
    }
  }

  const root = document.contents
  if (!isMap(root)) return failures
  const workflowEnvironment = environmentWith(new Map(), findPair(root, "env")?.value)
  const workflowShell = defaultRunShell(root)

  const isDirectWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(normalizedPath)
  const isActionManifest = /(?:^|\/)action\.ya?ml$/.test(normalizedPath) && !isDirectWorkflow
  if (!isActionManifest && normalizedPath.startsWith(".github/workflows/")) {
    let jobs = findPair(root, "jobs")?.value
    const jobsComment = jobs?.comment ?? ""
    if (isAlias(jobs)) jobs = jobs.resolve(document)
    if (!isMap(jobs)) return failures
    const enclosingJobsComment = jobs.items.length === 1 ? jobsComment || jobs.comment || "" : ""
    for (const jobPair of jobs.items) {
      const aliasComment = jobPair.value?.comment ?? ""
      const job = isAlias(jobPair.value) ? jobPair.value.resolve(document) : jobPair.value
      if (!isMap(job)) continue
      inspectUses(findPair(job, "uses"), aliasComment || job.comment || enclosingJobsComment)
      const jobEnvironment = environmentWith(workflowEnvironment, findPair(job, "env")?.value)
      const jobShell = defaultRunShell(job, workflowShell)
      inspectSteps(findPair(job, "steps")?.value, jobEnvironment, jobShell)
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
          else if (imageIsMutable(container.value)) {
            failures.push({ line, message: `container image must not use latest or unresolved expressions: ${container.value}`, path })
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
        else if (imageIsMutable(image.value)) {
          failures.push({ line, message: `container image must not use latest or unresolved expressions: ${image.value}`, path })
        }
      }
    }
  }
  else {
    let runs = findPair(root, "runs")?.value
    if (isAlias(runs)) runs = runs.resolve(document)
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
