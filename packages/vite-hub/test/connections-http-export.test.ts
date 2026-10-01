import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const frameworkRoot = fileURLToPath(new URL("../", import.meta.url))

it.each(["@vite-hub/connections/http", "vite-hub/connections/http"])("imports the published HTTP contract through %s", async (specifier) => {
  const source = `
    const module = await import(process.argv[1])
    const handler = module.createConnectionsHandler({ actor: () => "user:owner", runtime: () => ({ list: async () => [] }) })
    const response = await handler(new Request("http://localhost" + module.CONNECTIONS_ROUTE, {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ action: "list" }),
    }))
    console.log(JSON.stringify({ status: response.status, body: await response.json() }))
  `
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, specifier], { cwd: frameworkRoot, timeout: 15000 })
  expect(stderr).toBe("")
  expect(JSON.parse(stdout)).toEqual({ status: 200, body: { connections: [] } })
})
