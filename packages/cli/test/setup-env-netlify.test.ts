import process from "node:process"

import { expect, it } from "vitest"

import { netlifyEnv } from "../src/setup/deploy/netlify.ts"

it.each(["post_processing", "post-processing"])("removes %s from secret conversion", async (scope) => {
  const requests: { method?: string, body?: unknown }[] = []
  const adapter = netlifyEnv({
    root: process.cwd(),
    link: { host: "netlify", account: { id: "account" }, project: { id: "site", name: "app" }, verified: true, linkedAt: "" },
    target: "production",
    env: { NETLIFY_AUTH_TOKEN: "test-token" },
    secrets: [],
    run: async () => { throw new Error("No CLI call expected") },
    fetch: async (_input, init) => {
      requests.push({ method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
      return Response.json(init?.method === "GET" ? { key: "API_KEY", is_secret: false, scopes: ["builds", "functions", "runtime", scope], values: [{ context: "all", value: "old" }] } : {})
    },
  })
  await adapter.setSecret("API_KEY", "new", { secret: true })
  expect(requests[1]).toMatchObject({ method: "PUT", body: { is_secret: true, scopes: ["builds", "functions", "runtime"] } })
})
