import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"

import { collectContributions, describeContribution } from "@vite-hub/internal/contributions"

import { queueErrorDiagnostics } from "./error-diagnostics.ts"

import type { CollectedContribution, ContributingPlugin, Contribution, ContributionContext, ContributionFactory } from "@vite-hub/internal/contributions"

/**
 * A Queue Definition that another package adds from its Vite plugin. The Queue plugin merges it with the discovered
 * files, so the registry, the generated types, Cloudflare bindings, Vercel consumers, inspection, and provisioning
 * treat it like `server/queues/<name>.ts`.
 *
 * The generated registry imports the module by path, so `definition.module` must be an absolute file path or a `file:`
 * URL, and the module must `export default defineQueue(...)`.
 */
export type QueueContribution = Contribution

/** Roots that ViteHub passes to contribution factories. `root` is the Vite root. */
export type QueueContributionContext = ContributionContext

export type QueueContributionFactory = ContributionFactory<QueueContribution>

/** A Vite plugin that contributes Queue Definitions through `vitehub.queues`. */
export type QueueContributingPlugin = ContributingPlugin<"queues", QueueContribution>

/** A validated contribution with the name of the plugin that contributed it. */
export type CollectedQueueContribution = CollectedContribution

const queueNamePattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i

export { describeContribution as describeQueueContribution }

function invalid(message: string): Error {
  return queueErrorDiagnostics.QUEUE_CONTRIBUTION_INVALID({ message })
}

/**
 * Collects `vitehub.queues` contributions from Vite plugins. Two contributions with one name fail with
 * `QUEUE_DEFINITION_DUPLICATE`. Invalid entries fail with `QUEUE_CONTRIBUTION_INVALID`.
 */
export async function collectQueueContributions(
  plugins: readonly unknown[] | undefined,
  context: QueueContributionContext,
): Promise<CollectedQueueContribution[]> {
  const contributions = await collectContributions(plugins, {
    checkName: name => queueNamePattern.test(name)
      ? undefined
      : "`name` must be letters, numbers, dots, underscores, dashes, and slashes, for example \"webhooks/deliver\".",
    context,
    duplicate: message => queueErrorDiagnostics.QUEUE_DEFINITION_DUPLICATE({ message }),
    invalid,
    key: "queues",
    kind: "Queue",
  })
  for (const contribution of contributions) {
    const { export: exportName, module } = contribution.definition
    const prefix = `[vitehub] Plugin ${JSON.stringify(contribution.plugin)} contributed an invalid Queue:`
    // The generated registry and types import the module by a relative path and read its default export.
    if (!isAbsolute(module)) {
      throw invalid(`${prefix} \`definition.module\` of Queue ${JSON.stringify(contribution.name)} must be an absolute file path or a file: URL.`)
    }
    if (exportName !== "default") {
      throw invalid(`${prefix} Queue ${JSON.stringify(contribution.name)} uses \`definition.export: ${JSON.stringify(exportName)}\`. Queue Definitions must be the default export.`)
    }
    if (!existsSync(module)) {
      throw invalid(`${prefix} the module of Queue ${JSON.stringify(contribution.name)} does not exist: ${module}`)
    }
  }
  return contributions
}
