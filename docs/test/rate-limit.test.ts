import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const docsRoot = resolve(import.meta.dirname, "../content/docs")

function read(relativePath: string): string {
  return readFileSync(resolve(docsRoot, relativePath), "utf8")
}

const primitivePages = [
  "rate-limit/index.md",
  "rate-limit/get-started.md",
  "rate-limit/server-api.md",
  "rate-limit/hosts.md",
  "rate-limit/limits-and-errors.md",
]

function routeExists(route: string): boolean {
  const relativePath = route.replace(/^\/docs\/?/, "").replace(/\/$/, "")
  return existsSync(resolve(docsRoot, `${relativePath}.md`))
    || existsSync(resolve(docsRoot, relativePath, "index.md"))
}

describe("Rate Limit documentation", () => {
  it("keeps the new task routes resolvable", () => {
    for (const relativePath of [...primitivePages, "rate-limit/agent-capability.md"]) {
      const routes = [...read(relativePath).matchAll(/\]\((\/docs(?:\/[^)#\s]*)?)(?:#[^)]+)?\)/g)]
        .map(match => match[1]!)

      expect(routes.filter(route => !routeExists(route)), relativePath).toEqual([])
    }
  })
})
