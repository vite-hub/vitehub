import { isAbsolute } from "node:path"

import { collectContributions, describeContribution } from "@vite-hub/internal/contributions"

import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

import type { CollectedContribution, ContributingPlugin, Contribution, ContributionContext, ContributionFactory } from "@vite-hub/internal/contributions"

/**
 * A Schedule Definition that another package adds from its Vite plugin. The Schedule plugin merges it with the
 * discovered files, so provider wake output, the Process Runtime, `vitehub schedule run`, generated types, inspection,
 * and the Console treat it like `server/schedules/<name>.ts`.
 *
 * The build reads the cron and the `manual` and `allowRuntimeSchedules` options from the source of the Definition
 * module without running it, as it does for discovered files. `definition.module` must therefore be an absolute file
 * path or `file:` URL, and `definition.export` must be `default`: `export default defineSchedule({ cron: "...", handler })`
 * with literal options, or `export default defineScheduleTarget({ handler })`.
 */
export type ScheduleContribution = Contribution

/** Roots that ViteHub passes to contribution factories. `root` is the Vite root. */
export type ScheduleContributionContext = ContributionContext

export type ScheduleContributionFactory = ContributionFactory<ScheduleContribution>

/** A Vite plugin that contributes Schedule Definitions through `vitehub.schedules`. */
export type ScheduleContributingPlugin = ContributingPlugin<"schedules", ScheduleContribution>

/** A validated contribution with the name of the plugin that contributed it. */
export type CollectedScheduleContribution = CollectedContribution

const scheduleNamePattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i

export { describeContribution as describeScheduleContribution }

/** Error for a Schedule name with two definitions. Both sources are named so the user knows which to rename. */
export function duplicateScheduleError(name: string, first: string, second: string): Error {
  return scheduleErrorDiagnostics.SCHEDULE_B0006({ message: `[vitehub] Schedule "${name}" is defined more than once:\n  - ${first}\n  - ${second}\nRename or remove one definition. Each Schedule name must have one definition.` })
}

function invalidContribution(contribution: CollectedScheduleContribution, reason: string): Error {
  return scheduleErrorDiagnostics.SCHEDULE_B0007({ message: `[vitehub] Plugin ${JSON.stringify(contribution.plugin)} contributed an invalid Schedule: ${reason}` })
}

/**
 * Collects `vitehub.schedules` contributions from Vite plugins. Two contributions with one name fail with
 * `SCHEDULE_B0006`. Invalid entries fail with `SCHEDULE_B0007`.
 */
export async function collectScheduleContributions(
  plugins: readonly unknown[] | undefined,
  context: ScheduleContributionContext,
): Promise<CollectedScheduleContribution[]> {
  const contributions = await collectContributions(plugins, {
    checkName: name => scheduleNamePattern.test(name)
      ? undefined
      : "`name` must be letters, numbers, dots, underscores, dashes, and slashes, for example \"content/publish\".",
    context,
    duplicate: message => scheduleErrorDiagnostics.SCHEDULE_B0006({ message }),
    invalid: message => scheduleErrorDiagnostics.SCHEDULE_B0007({ message }),
    key: "schedules",
    kind: "Schedule",
  })
  for (const contribution of contributions) {
    const { export: exportName, module } = contribution.definition
    // The build reads the cron from the module source, so it needs a file and the default export.
    if (!isAbsolute(module)) {
      throw invalidContribution(contribution, `\`definition.module\` of Schedule ${JSON.stringify(contribution.name)} must be an absolute file path or a file: URL, because the build reads its cron from source.`)
    }
    if (exportName !== "default") {
      throw invalidContribution(contribution, `Schedule ${JSON.stringify(contribution.name)} uses \`definition.export: ${JSON.stringify(exportName)}\`. Schedule Definitions must be the default export, because the build reads its cron from \`export default defineSchedule()\`.`)
    }
  }
  return contributions
}
