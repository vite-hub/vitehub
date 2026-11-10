import { useState } from "#imports"

/** The mounted sidebar footer that can receive the header's single custom action instance. */
export function useDocsHeaderActionsTarget() {
  return useState<string | null>("docs-header-actions-target", () => null)
}
