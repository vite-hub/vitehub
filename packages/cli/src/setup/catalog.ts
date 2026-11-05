import { featureHosts, featureIds, features } from "@vite-hub/internal/features"

import type { FeatureDefinition, FeatureHost } from "@vite-hub/internal/features"

export interface SetupCatalog {
  schemaVersion: 1
  hosts: readonly FeatureHost[]
  features: readonly FeatureDefinition[]
}

/** Every feature of `vitehub({...})` and how each host supports it. Needs no project. */
export function setupCatalog(): SetupCatalog {
  return { features: featureIds.map(id => features[id]), hosts: featureHosts, schemaVersion: 1 }
}
