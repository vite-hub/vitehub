import { formatMigrationReport, runMigration } from "./migrate.ts"
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
    "Usage: npx @vite-hub/codemods [dir] [--dry-run]",
    "       npx @vite-hub/codemods <codemod> [dir] [--dry-run]",
    "",
    "Without a codemod name, it detects every supported module in the app and migrates them all.",
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
  if (flags.includes("--help") || flags.includes("-h")) {
    output.stdout(helpText())
    return 0
  }
  const dryRun = flags.includes("--dry-run")
  const [first, ...rest] = positionals
  const single = first !== undefined && codemods.some(codemod => codemod.name === first)
  const extra = single ? rest.slice(1) : rest
  if (extra.length) {
    output.stderr(`Too many arguments: ${extra.join(" ")}.\n\n${helpText()}`)
    return 1
  }
  try {
    if (single) {
      const run = await runCodemod(first, { cwd: rest[0], dryRun })
      if (run.dryRun && run.result.edits.length) output.stdout(`${formatDiff(run.result)}\n`)
      output.stdout(formatReport(run))
      return 0
    }
    const migration = await runMigration({ cwd: first, dryRun })
    if (migration.dryRun && migration.edits.length) output.stdout(`${formatDiff({ edits: migration.edits })}\n`)
    output.stdout(formatMigrationReport(migration))
    return migration.steps.some(step => step.error) ? 1 : 0
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
