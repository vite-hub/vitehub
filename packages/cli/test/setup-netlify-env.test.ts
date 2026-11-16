import { expect, it, vi } from "vitest"

import { netlifyEnv } from "../src/setup/deploy/netlify.ts"

it.each([404, 403])("handles a Netlify variable lookup with status %s", async (status) => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ message: "Lookup failed" }, { status }))
    .mockResolvedValueOnce(Response.json({}))
  const env = netlifyEnv({
    root: process.cwd(),
    link: { host: "netlify", account: { id: "account" }, project: { id: "site", name: "my-app" }, verified: true, linkedAt: "2026-11-16T00:00:00Z" },
    target: "production",
    env: { NETLIFY_AUTH_TOKEN: "test-token" },
    run: async () => { throw new Error("No host command expected") },
    fetch: request,
    secrets: ["test-token"],
  })

  const result = env.setSecret("GITHUB_TOKEN", "value", { secret: true })
  if (status === 404) {
    await expect(result).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "POST" })
  }
  else {
    await expect(result).rejects.toMatchObject({ code: "INTERNAL_R0013", status: 403 })
    expect(request).toHaveBeenCalledTimes(1)
  }
})
