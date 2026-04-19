export type {
  LiveDeployManifest,
  LiveTargetDefinition,
} from "@vitehub/internal-ci/live-target"

export function getLiveTargetDefinitions(options: {
  packageDir: string
  packageName: string
  workspaceDir: string
}): import("@vitehub/internal-ci/live-target").LiveTargetDefinition[]

export function prepareLiveDeployTarget(options: {
  framework: string
  packageDir: string
  packageName: string
  provider: string
  workspaceDir: string
}): import("@vitehub/internal-ci/live-target").LiveDeployManifest
