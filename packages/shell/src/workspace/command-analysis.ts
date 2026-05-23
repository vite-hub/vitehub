export interface WorkspaceInspectionCommandSegment {
  command: string
  followsPipe: boolean
  paths: string[]
  searchRecursive: boolean
  separatorAfter?: "&&" | "||" | "|" | ";" | "\n"
  words: string[]
}

export function analyzeWorkspaceInspectionCommand(command: string): WorkspaceInspectionCommandSegment[] {
  return splitShellCommandSegments(command).map((segment) => {
    const words = parseShellWords(segment.command)
    return {
      ...segment,
      paths: shellPathArguments(words),
      searchRecursive: hasRecursiveGrepFlag(words),
      words,
    }
  })
}

function shellPathArguments(words: string[]) {
  switch (words[0]) {
    case "rg":
    case "grep":
      return commandPathArguments(words[0], words)
    case "find":
      return findPathArguments(words)
    case "cat":
    case "head":
    case "tail":
    case "wc":
    case "ls":
      return fileCommandPathArguments(words)
    default:
      return []
  }
}

function findPathArguments(words: string[]) {
  const paths: string[] = []
  let collectingPaths = true
  for (const arg of words.slice(1)) {
    if (isShellOperator(arg)) break
    if (collectingPaths && isFindLeadingOption(arg)) continue
    if (arg.startsWith("-")) break
    collectingPaths = false
    paths.push(arg)
  }
  return paths
}

function fileCommandPathArguments(words: string[]) {
  const paths: string[] = []
  for (let index = 1; index < words.length; index++) {
    const arg = words[index]!
    if (arg === "--") {
      paths.push(...pathArgumentsUntilShellBoundary(words.slice(index + 1)))
      break
    }
    if (isShellOperator(arg)) break
    if (arg.startsWith("-")) {
      if (takesFileCommandOptionValue(words[0]!, arg)) index += 1
      continue
    }
    paths.push(arg)
  }
  return paths
}

function isShellOperator(arg: string) {
  return arg === "&&" || arg === "||" || isRedirectOperator(arg)
}

function isRedirectOperator(arg: string) {
  return /^(?:\d*)[<>]+&?\d*$/.test(arg) || /^(?:\d*)[<>]/.test(arg)
}

function isFindLeadingOption(arg: string) {
  return arg === "-H" || arg === "-L" || arg === "-P"
}

function commandPathArguments(command: string, words: string[]) {
  const args = words.slice(1)
  const paths: string[] = []
  let sawPattern = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      paths.push(...searchPathArgumentsAfterTerminator(args.slice(index + 1), sawPattern))
      break
    }
    if (isShellOperator(arg) && sawPattern) break
    if (arg.startsWith("-")) {
      if (takesOptionValue(command, arg)) {
        if (takesSearchPatternOptionValue(arg)) sawPattern = true
        index += 1
      }
      else if (takesInlineOptionValue(command, arg)) {
        continue
      }
      else if (takesInlineSearchPatternOptionValue(arg)) {
        sawPattern = true
      }
      continue
    }
    if (!sawPattern) {
      sawPattern = true
      continue
    }
    paths.push(arg)
  }
  return paths
}

function searchPathArgumentsAfterTerminator(args: string[], sawPattern: boolean) {
  if (sawPattern) return pathArgumentsUntilShellBoundary(args)
  return pathArgumentsUntilShellBoundary(args.slice(1))
}

function takesOptionValue(command: string, arg: string) {
  const grepOptions = [
    "-A",
    "-B",
    "-C",
    "-e",
    "-f",
    "-m",
    "-d",
    "--after-context",
    "--before-context",
    "--context",
    "--directories",
    "--max-count",
    "--regexp",
  ]
  const rgOptions = [
    ...grepOptions,
    "-g",
    "-t",
    "-T",
    "--glob",
    "--ignore-file",
    "--max-depth",
    "--max-filesize",
    "--type",
    "--type-add",
    "--type-clear",
    "--type-not",
  ]
  return (command === "grep" ? grepOptions : rgOptions).includes(arg)
}

function takesInlineOptionValue(command: string, arg: string) {
  const shared = (arg.startsWith("-d") && arg !== "-d")
    || arg.startsWith("--directories=")
  if (command === "grep") return shared
  return shared
    || arg.startsWith("--ignore-file=")
    || arg.startsWith("--max-depth=")
    || arg.startsWith("--max-filesize=")
    || arg.startsWith("--type=")
    || arg.startsWith("--type-add=")
    || arg.startsWith("--type-clear=")
    || arg.startsWith("--type-not=")
}

function takesSearchPatternOptionValue(arg: string) {
  return arg === "-e" || arg === "-f" || arg === "--regexp"
}

function takesInlineSearchPatternOptionValue(arg: string) {
  return arg.startsWith("--regexp=")
    || (arg.startsWith("-e") && arg !== "-e")
    || (arg.startsWith("-f") && arg !== "-f")
}

function takesFileCommandOptionValue(command: string, arg: string) {
  if (command === "head" || command === "tail") {
    return arg === "-c"
      || arg === "-n"
      || arg === "--bytes"
      || arg === "--lines"
  }
  if (command === "ls") {
    return arg === "-I" || arg === "--ignore"
  }
  return false
}

function pathArgumentsUntilShellBoundary(args: string[]) {
  const paths: string[] = []
  for (const arg of args) {
    if (isShellOperator(arg)) break
    paths.push(arg)
  }
  return paths
}

function splitShellCommandSegments(command: string) {
  const segments: Array<{ command: string, followsPipe: boolean, separatorAfter?: "&&" | "||" | "|" | ";" | "\n" }> = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false
  let followsPipe = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      current += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      current += char
      continue
    }
    const next = command[index + 1]
    if (char === "&" && next === "&") {
      segments.push({ command: current, followsPipe, separatorAfter: "&&" })
      current = ""
      followsPipe = false
      index += 1
      continue
    }
    if (char === "|" && next === "|") {
      segments.push({ command: current, followsPipe, separatorAfter: "||" })
      current = ""
      followsPipe = false
      index += 1
      continue
    }
    if (char === "|" || char === ";" || char === "\n") {
      segments.push({ command: current, followsPipe, separatorAfter: char })
      current = ""
      followsPipe = char === "|"
      continue
    }
    current += char
  }
  segments.push({ command: current, followsPipe })
  return segments
}

function hasRecursiveGrepFlag(words: string[]) {
  const args = words.slice(1)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--recursive" || arg === "-r" || arg === "-R") return true
    if (arg === "--directories" || arg === "-d") return args[index + 1] === "recurse"
    if (arg === "--directories=recurse" || arg === "-drecurse") return true
    if (takesOptionValue("grep", arg)) {
      index += 1
      continue
    }
    if (takesInlineSearchPatternOptionValue(arg)) continue
    if (!/^-[^-]/.test(arg)) return false
    if ((arg.startsWith("-e") || arg.startsWith("-f")) && arg.length > 2) return false
    if (arg.includes("r") || arg.includes("R")) return true
  }
  return false
}

function parseShellWords(command: string) {
  const words: string[] = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false
  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) words.push(current)
  return words
}
