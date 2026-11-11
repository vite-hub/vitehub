import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import { expect, it } from "vitest"

it("constructs the Setup route with the project API paths", () => {
  const client = readFileSync(`${import.meta.dirname}/../src/console/runtime/client/main.js`, "utf8")
  const start = client.indexOf("const router = createRouter(")
  const end = client.indexOf("\n});", start) + "\n});".length
  const router: { routes: Array<{ path: string, props?: unknown }> } = runInNewContext(`${client.slice(start, end)}\nrouter`, {
    ...Object.fromEntries([...client.matchAll(/const (Console\w+) =/g)].map(([, name]) => [name, {}])),
    createRouter: (options: unknown) => options,
    createWebHistory: (base: string) => base,
    consoleBase: "/_vitehub/",
    consoleDatabasesSchemaPath: "/databases/schema",
    consoleDatabasesTablePath: "/databases/:table?",
    sectionsBase: "/_vitehub/api/sections",
    capabilitiesBase: "/_vitehub/api/invocation-capabilities",
  })
  expect(JSON.parse(JSON.stringify(router.routes.find(route => route.path === "/setup")?.props))).toEqual({
    agentsBase: "/_vitehub/api/agents",
    definitionsBase: "/_vitehub/api/definitions",
    kvBase: "/_vitehub/api/kv",
    searchBase: "/_vitehub/api/search",
    sectionsBase: "/_vitehub/api/sections",
  })
})
