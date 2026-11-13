import { resolve } from "node:path"
import { parseArgs } from "node:util"

import { importOptionalOwner, requireOptionalOwner } from "./internal/optional-owners.ts"

import type { ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli"

const usage = "vitehub migrate [--dry-run], or vitehub migrate run <dir> [--dry-run]"

/** Runs the upgrade codemods of `@vite-hub/codemods` on one app folder, in release order. */
async function runMigrate(args: string[], context: ViteHubCliContext): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { "dry-run": { type: "boolean" } } })
  if (positionals.length > 1) {
    context.stderr.write(`[vitehub] Too many arguments: ${positionals.join(" ")}. Usage: ${usage}\n`)
    return 1
  }
  const codemods = requireOptionalOwner(await importOptionalOwner("@vite-hub/codemods", () => import("@vite-hub/codemods")), "migrate")
  const cwd = resolve(context.cwd, positionals[0] ?? ".")
  let failed = false
  for (const codemod of codemods.upgradeCodemods) {
    try {
      const run = await codemods.runCodemod(codemod.name, { cwd, dryRun: values["dry-run"] === true })
      if (run.dryRun && run.result.edits.length) context.stdout.write(`${codemods.formatDiff(run.result)}\n`)
      context.stdout.write(codemods.formatReport(run))
    }
    catch (error) {
      if (!(error instanceof codemods.CodemodError)) throw error
      context.stderr.write(`[vitehub] ${codemod.name}: ${error.message}\n`)
      failed = true
    }
  }
  return failed ? 1 : 0
}

export function createMigrateCliNamespace(): ViteHubCliCommandNamespace {
  return {
    defaultFeature: "run",
    description: "Rewrite the app for this ViteHub release. Does not load the project config.",
    features: [{
      description: "Run the upgrade codemods on the app folder (default: the current folder). --dry-run prints the diffs.",
      name: "run",
      run: runMigrate,
      usage,
    }],
    name: "migrate",
  }
}
