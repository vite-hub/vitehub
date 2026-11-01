import { codemods } from "./registry.ts"
import { formatDiff, formatReport, runCodemod } from "./runner.ts"
import { CodemodError } from "./types.ts"

export interface CliOutput {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const defaultOutput: CliOutput = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

function helpText(): string {
  const width = Math.max(...codemods.map(codemod => codemod.name.length))
  return [
    "Usage: npx @vite-hub/codemods <codemod> [dir] [--dry-run]",
    "",
    "Codemods:",
    ...codemods.map(codemod => `  ${codemod.name.padEnd(width)}  ${codemod.description}`),
    "",
    "Options:",
    "  --dry-run  Print the planned edits and write nothing.",
    "  --help     Show this list.",
    "",
  ].join("\n")
}

/** Runs the CLI with arguments after the binary name. Returns the exit code. */
export async function runCli(argv: readonly string[], output: CliOutput = defaultOutput): Promise<number> {
  const flags = argv.filter(arg => arg.startsWith("-"))
  const positionals = argv.filter(arg => !arg.startsWith("-"))
  const unknownFlag = flags.find(flag => !["--dry-run", "--help", "-h"].includes(flag))
  if (unknownFlag) {
    output.stderr(`Unknown option ${unknownFlag}.\n\n${helpText()}`)
    return 1
  }
  const [name, dir, ...extra] = positionals
  if (!name || flags.includes("--help") || flags.includes("-h")) {
    output.stdout(helpText())
    return 0
  }
  if (extra.length) {
    output.stderr(`Too many arguments: ${extra.join(" ")}.\n\n${helpText()}`)
    return 1
  }
  try {
    const run = await runCodemod(name, { cwd: dir, dryRun: flags.includes("--dry-run") })
    if (run.dryRun && run.result.edits.length) output.stdout(`${formatDiff(run.result)}\n`)
    output.stdout(formatReport(run))
    return 0
  }
  catch (error) {
    if (error instanceof CodemodError) {
      output.stderr(`Error: ${error.message}\n`)
      return 1
    }
    output.stderr(`Error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    return 1
  }
}
