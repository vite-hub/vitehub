import { describe, expectTypeOf, it } from "vitest"

import { blob, file, type BlobStorage, type BlobStoreName, type BlobStoreRegistry } from "../src/index.ts"

// `test/store-types.test.ts` compiles an app with a generated registry. This program has none.
describe("Blob store names without generated types", () => {
  it("has an empty registry", () => {
    expectTypeOf<keyof BlobStoreRegistry>().toEqualTypeOf<never>()
  })

  it("accepts any store name", () => {
    expectTypeOf<BlobStoreName>().toEqualTypeOf<"default" | (string & {})>()
    expectTypeOf(blob.store("any-name")).toEqualTypeOf<BlobStorage>()
    file({ store: "any-name" })
  })
})
