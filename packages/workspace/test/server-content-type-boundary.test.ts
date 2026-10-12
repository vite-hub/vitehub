import { describe, expect, it } from "vitest"

import { readWorkspaceFileResponse } from "../src/server.ts"

describe("workspace file response content types", () => {
  it("does not read inherited content type mappings", async () => {
    const contentTypes = Object.create({ ".txt": "application/x-prototype" }) as Record<string, string>
    const workspace = {
      fs: {
        readFile: async () => "hello",
        stat: async () => ({ type: "file" as const }),
      },
    }

    const response = await readWorkspaceFileResponse({
      contentTypes,
      path: "file.txt",
      workspace: workspace as never,
    })

    expect(response.headers.get("content-type")).toBe("text/plain")
  })
})
