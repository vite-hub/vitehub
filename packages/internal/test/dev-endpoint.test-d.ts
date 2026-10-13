import { expectTypeOf } from "vitest"

import { assertViteHubDevRequestGrant, forwardViteHubDevRequestToNitro, registerViteHubDevEndpoint, validateViteHubNitroDevRequest } from "../src/dev-endpoint.ts"

import type { IncomingMessage } from "node:http"
import type { ViteHubDevEndpointServer, ViteHubDevRequestCheck, ViteHubDevRequestGrant } from "../src/dev-endpoint.ts"

declare const server: ViteHubDevEndpointServer
declare const req: IncomingMessage
declare const request: Request
const guard = { header: "x-test-dev", headerValue: "1", label: "Test Dev" }

expectTypeOf(validateViteHubNitroDevRequest(request, guard)).resolves.toEqualTypeOf<ViteHubDevRequestCheck>()

export async function devRequestGrantContract(): Promise<void> {
  const check = await validateViteHubNitroDevRequest(request, guard)
  if (check.grant) assertViteHubDevRequestGrant(check.grant, request)
  // @ts-expect-error A check can hold a rejection, so it is not a grant before the caller narrows it.
  assertViteHubDevRequestGrant(check.grant, request)
  // @ts-expect-error A label alone is not a grant.
  assertViteHubDevRequestGrant({ label: "Test Dev" }, request)
  // @ts-expect-error A boolean check result is not a grant.
  assertViteHubDevRequestGrant(true, request)

  // @ts-expect-error Forwarding to Nitro requires the grant of the guarded request.
  await forwardViteHubDevRequestToNitro({}, req, { ...guard, runtimeRoute: "/_vitehub/test/dev" })

  registerViteHubDevEndpoint(server, {
    ...guard,
    handle: (_req, _res, grant) => expectTypeOf(grant).toEqualTypeOf<ViteHubDevRequestGrant>(),
    route: "/__test/dev",
  })
}
