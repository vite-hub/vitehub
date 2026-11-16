import { resolve } from "node:path"
import { parseArgs } from "node:util"

import { importOptionalOwner, requireOptionalOwner } from "./internal/optional-owners.ts"

import type { ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli"

const usage = "vitehub migrate [dir] [--dry-run]"

/** Silent Result failures are not syntax, so no codemod finds them. The Doctor rule does. */
const resultCheck = "Run Vite Doctor. Rule VHUB0003 lists Result calls whose error the code drops, such as `await email.send(...)` as a statement."

/** Runs every upgrade codemod of `@vite-hub/codemods` that applies to one app folder, in release order. */
async function runMigrate(args: string[], context: ViteHubCliContext): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { "dry-run": { type: "boolean" }, "help": { type: "boolean", short: "h" } } })
  if (values.help) {
    context.stdout.write(`Usage: ${usage}\n\nRuns every upgrade codemod that applies to the app folder (default: the current folder). --dry-run prints the diffs and writes nothing.\n`)
    return 0
  }
  if (positionals.length > 1) {
    context.stderr.write(`[vitehub] Too many arguments: ${positionals.join(" ")}. Usage: ${usage}\n`)
    return 1
  }
  const codemods = requireOptionalOwner(await importOptionalOwner("@vite-hub/codemods", () => import("@vite-hub/codemods")), "migrate")
  const cwd = resolve(context.cwd, positionals[0] ?? ".")
  try {
    const migration = await codemods.runMigration({ cwd, dryRun: values["dry-run"] === true, codemods: codemods.upgradeCodemods })
    if (migration.dryRun && migration.edits.length) context.stdout.write(`${codemods.formatDiff({ edits: migration.edits })}\n`)
    context.stdout.write(codemods.formatMigrationReport(migration, [resultCheck]))
    return migration.steps.some(step => step.error) ? 1 : 0
  }
  catch (error) {
    if (!codemods.isCodemodError(error)) throw error
    context.stderr.write(`[vitehub] ${error.message}\n${error.fix ? `Fix: ${error.fix}\n` : ""}`)
    return 1
  }
}

export function createMigrateCliNamespace(): ViteHubCliCommandNamespace {
  return {
    defaultFeature: "migrate",
    description: "Rewrite the app for this ViteHub release. Does not load the project config.",
    features: [{
      description: "Run every upgrade codemod that applies to the app folder (default: the current folder). --dry-run prints the diffs.",
      name: "migrate",
      run: runMigrate,
      usage,
    }],
    name: "migrate",
  }
}
