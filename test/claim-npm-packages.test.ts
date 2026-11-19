import { afterEach, beforeEach, expect, it, vi } from "vitest"

const { npm } = vi.hoisted(() => ({
  npm: vi.fn<(command: string, args: string[]) => { status: number; stdout: string }>(),
}))
vi.mock("node:child_process", () => ({ spawnSync: npm }))

const name = "@vite-hub/device"
const trustUrl = `https://registry.npmjs.org/-/package/${name.replace("/", "%2f")}/trust`
const release = {
  type: "github",
  claims: { repository: "vite-hub/vitehub", workflow_ref: { file: "release.yml" }, environment: "npm-release" },
  permissions: ["createPackage", "createStagedPackage"],
}
const argv = process.argv

beforeEach(() => {
  process.argv = [...argv.slice(0, 2), name]
  vi.stubEnv("NPM_TOKEN", "test-token")
})

afterEach(() => {
  process.argv = argv
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  npm.mockReset()
})

function run() {
  vi.resetModules()
  return import("../.github/scripts/claim-npm-packages.mjs")
}

it("resumes trust setup without publishing again or replacing an existing publisher", async () => {
  let published = false
  let attempts = 0
  npm.mockImplementation((command, args) => {
    expect(command).toBe("npm")
    let stdout = ""
    if (args[0] === "access") {
      stdout = JSON.stringify(published ? { [name]: "read-write" } : {})
    }
    else if (args[0] === "publish") {
      expect(published).toBe(false)
      published = true
    }
    else {
      throw new Error(`Unexpected npm arguments: ${args}`)
    }
    return { status: 0, stdout }
  })

  const registry = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === `https://registry.npmjs.org/${encodeURIComponent(name)}`) return new Response(null, { status: 404 })
    expect(url).toBe(trustUrl)
    if (options?.method === "GET") return Response.json(attempts === 2 ? release : [])
    expect(options?.method).toBe("POST")
    expect(options?.body).toBe(JSON.stringify([release]))
    return new Response(null, { status: ++attempts === 1 ? 503 : 204 })
  })
  vi.stubGlobal("fetch", registry)

  await expect(run()).rejects.toThrow(`POST ${trustUrl} answered 503`)
  await run()
  expect(attempts).toBe(2)
  registry.mockClear()
  await run()
  expect(registry.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([[trustUrl, "GET"]])
  expect(npm.mock.calls.filter(([, args]) => args[0] === "publish")).toHaveLength(1)
})

it.each([
  { ...release, id: "wrong-env", claims: { ...release.claims, environment: "npm" } },
  { ...release, id: "stage-only", permissions: ["createStagedPackage"] },
])("repairs a $id link without revoking unrelated publishers", async (stale) => {
  npm.mockReturnValue({ status: 0, stdout: JSON.stringify({ [name]: "read-write" }) })
  const unrelated = [
    { ...release, id: "other-repo", claims: { ...release.claims, repository: "vite-hub/another-repo" } },
    { ...release, id: "other-workflow", claims: { ...release.claims, workflow_ref: { file: "preview.yml" } } },
    { type: "circleci", id: "circleci", permissions: ["createPackage"] },
  ]
  const registry = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === trustUrl && options?.method === "GET") return Response.json([stale, ...unrelated])
    if (url === `${trustUrl}/${stale.id}` && options?.method === "DELETE") {
      return new Response(null, { status: 204 })
    }
    expect([url, options?.method, options?.body]).toEqual([trustUrl, "POST", JSON.stringify([release])])
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal("fetch", registry)

  await run()
  expect(registry.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
    [trustUrl, "GET"],
    [`${trustUrl}/${stale.id}`, "DELETE"],
    [trustUrl, "POST"],
  ])
})
