import { expect, it } from "vitest"
import { createAuthUsers } from "../src/operations-core/server.ts"

it("matches Auth mention suggestions without case sensitivity", async () => {
  const users = createAuthUsers(() => ({
    $context: Promise.resolve({ internalAdapter: {
      async listUsers(_limit, _offset, _sort, filters) {
        const filter = filters?.[0] as { value: string, mode?: string }
        const name = filter.mode === "insensitive" ? "ana" : "Ana"
        return name.includes(filter.value) ? [{ id: "ana", name: "Ana", email: "private@example.test" }] : []
      },
    } }),
  }))
  expect(await users.search("an", 10)).toEqual([{ id: "ana", name: "Ana" }])
})
