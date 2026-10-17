import { collectContributions, describeContribution } from "@vite-hub/internal/contributions"

import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

import type { CollectedContribution, ContributingPlugin, Contribution, ContributionContext, ContributionFactory } from "@vite-hub/internal/contributions"

/**
 * A Workspace Definition that another package registers from its Vite plugin. The Workspace plugin adds it to the
 * generated registry next to the discovered files, so `useWorkspace(name)`, typegen, inspection, and the Console
 * treat it like `server/workspaces/<name>.ts`. `definition.export` names the export that holds the `defineWorkspace()`
 * result.
 */
export type WorkspaceContribution = Contribution

/** Roots that ViteHub passes to contribution factories. `root` is the Vite root. */
export type WorkspaceContributionContext = ContributionContext

export type WorkspaceContributionFactory = ContributionFactory<WorkspaceContribution>

/** A Vite plugin that contributes Workspace Definitions through `vitehub.workspaces`. */
export type WorkspaceContributingPlugin = ContributingPlugin<"workspaces", WorkspaceContribution>

/** A validated contribution with its export resolved and the name of the plugin that contributed it. */
export type CollectedWorkspaceContribution = CollectedContribution

export { describeContribution as describeWorkspaceContribution }

/**
 * Collects `vitehub.workspaces` contributions from Vite plugins. Invalid entries fail with `WORKSPACE_B0004`. Two
 * contributions with one name fail with `WORKSPACE_B0003`.
 */
export async function collectWorkspaceContributions(
  plugins: readonly unknown[] | undefined,
  context: WorkspaceContributionContext,
): Promise<CollectedWorkspaceContribution[]> {
  return await collectContributions(plugins, {
    context,
    duplicate: message => workspaceErrorDiagnostics.WORKSPACE_B0003({ message }),
    invalid: message => workspaceErrorDiagnostics.WORKSPACE_B0004({ message }),
    key: "workspaces",
    kind: "Workspace",
  })
}
