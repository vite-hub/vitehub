import { expectTypeOf, it } from "vitest"

import { defineMcpResource } from "../src/index.ts"

it("preserves resource inference but rejects the removed public key", () => {
  const resource = defineMcpResource({ uri: "test:resource", access: "public", handler: () => "ok" })
  expectTypeOf(resource.access).toEqualTypeOf<"public">()
  // @ts-expect-error Use access: "public" instead.
  defineMcpResource({ uri: "test:resource", public: true, handler: () => "ok" })
})
