import { expect, it, vi } from "vitest"

import { mcpResources } from "../../src/mcp.ts"

it("reads a resource page larger than the JavaScript argument limit", async () => {
  const resources = Array.from({ length: 150_000 }, (_, index) => ({
    name: `resource-${index}.txt`,
    uri: `resource://example/${index}`,
    mimeType: "text/plain",
  }))
  const readResource = vi.fn(async () => ({ contents: [] }))
  const source = mcpResources({
    path: resource => resource.name,
    server: {
      async listResources(params) {
        return params?.cursor
          ? { resources: [{ name: "last.txt", uri: "resource://example/last", mimeType: "text/plain" }] }
          : { nextCursor: "next", resources }
      },
      readResource,
    },
  })
  const keys = await source.getKeys({ rootDir: process.cwd() })
  expect(keys).toHaveLength(150_001)
  expect(keys[0]).toBe("resource-0.txt")
  expect(keys[149_999]).toBe("resource-149999.txt")
  expect(keys.at(-1)).toBe("last.txt")
  expect(readResource).not.toHaveBeenCalled()
})
