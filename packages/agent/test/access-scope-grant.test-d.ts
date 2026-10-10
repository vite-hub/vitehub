import { it } from "vitest"
import { grantWorkspaceAccessScope, trustedWorkspaceAccessScope } from "../src/access-runtime.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
// @ts-expect-error The public entry does not export the access scope grant owner.
import { grantWorkspaceAccessScope as publicGrantWorkspaceAccessScope } from "../src/index.ts"

it("keeps the trusted access scope read only and owner created", () => {
  const context = createAgentInvocationContextStore()
  grantWorkspaceAccessScope(context, { all: false, paths: ["docs"], role: "viewer", scope: "support", sources: [] })
  const grant = trustedWorkspaceAccessScope(context)
  if (!grant) return

  // @ts-expect-error Readers cannot widen the granted scope.
  grant.all = true
  // @ts-expect-error Readers cannot add granted paths.
  grant.paths.push("secrets")
  // @ts-expect-error Readers cannot add granted Sources.
  grant.sources.push("secrets")
  // @ts-expect-error The public "access" context value is not a complete grant.
  grantWorkspaceAccessScope(context, context.get("access"))
  void publicGrantWorkspaceAccessScope
})
