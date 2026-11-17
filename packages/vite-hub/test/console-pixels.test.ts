import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"

it("keeps the Home shot when the catch-all expands to the same path", async () => {
  const source = readFileSync(new URL("./console-pixels.browser.mjs", import.meta.url), "utf8")
  const discovery = source.slice(source.indexOf("async function discoverTargets("), source.indexOf("async function shoot("))
  const files = new Set<string>()
  const discover = runInNewContext(`${discovery}; discoverTargets`, {
    options: {},
    settle: async () => {},
    shoot: async (_session: unknown, _origin: string, path: string) => {
      files.add("home.png")
      return { file: "home.png", path, landed: "/", params: {}, route: "home" }
    },
    join: (_folder: string, file: string) => file,
    rm: async (file: string) => { files.delete(file) },
  })
  const result = await discover({ page: { evaluate: async () => [
    { name: "home", path: "/" },
    { name: "pending", path: "/:pathMatch(.*)*" },
  ] } }, "http://localhost", "shots")
  expect(result.paths).toEqual(["/"])
  expect(files.has("home.png")).toBe(true)
  expect(result.routes.every((route: { shot?: string }) => route.shot === "home.png")).toBe(true)
})
