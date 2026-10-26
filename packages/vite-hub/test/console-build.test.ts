import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleBuildKey, consoleBuildRegistryKey, consoleBuildRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey } from "../src/console/internal.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { consoleBuildCheckInterval, useConsoleUpdate, watchConsoleBuild } from "../src/console/runtime/client/build.ts"
import { loadConsoleNavigation } from "../src/console/runtime/client/sections.ts"
import sectionsHandlerRoute from "../src/console/runtime/server/sections.get.ts"
import { installConsoleBuild, installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"
import type { ConsoleRpcResult } from "../src/console/runtime/rpc.ts"
import { allowed } from "./support/console-access.ts"

const sectionsHandler = allowed(sectionsHandlerRoute)
const scope = globalThis as ConsoleInvocationScope
const buildPattern = /installConsoleBuild\("[^"]+", "([0-9a-f]{16})"\)\n$/

function event(): ConsoleRequestEvent {
  const headers = new Headers({ host: "localhost" })
  return {
    headers,
    method: "GET",
    node: { req: { method: "GET", socket: { remoteAddress: "127.0.0.1" }, url: "http://localhost/_vitehub" } },
    req: { method: "GET", url: "http://localhost/_vitehub" },
  }
}

async function generatedBuild(file: string, root: string, sections: Parameters<typeof writeConsoleNitroPlugin>[2]): Promise<string> {
  await writeConsoleNitroPlugin(file, root, sections, [], { agents: [], content: {} }, [], ["default"])
  const build = buildPattern.exec(await readFile(file, "utf8"))?.[1]
  if (!build) throw new TypeError("Expected the generated Console plugin to install a build id.")
  return build
}

/** A document whose visibility a test sets. `watchConsoleBuild()` reads only these members. */
function stubDocument(): { show: () => void } {
  const target = new EventTarget()
  const document = Object.assign(target, { visibilityState: "visible" })
  vi.stubGlobal("document", document)
  return {
    show: () => {
      document.visibilityState = "visible"
      target.dispatchEvent(new Event("visibilitychange"))
    },
  }
}

/** Answers each Console sections call with the next build id. */
function stubSections(builds: string[]): ReturnType<typeof vi.fn> {
  const sectionsMock = vi.fn(async () => {
    const build = builds.length > 1 ? builds.shift() : builds[0]
    const result: ConsoleRpcResult = { ok: true, value: { build, sections: ["kv"] } }
    return Response.json(result)
  })
  vi.stubGlobal("fetch", async (url: string) => {
    // Navigation also opens the page tools session; it must not consume a build id.
    if (url.endsWith("/_vitehub/page/session")) return Response.json({ tools: [] })
    expect(url).toMatch(/\/_vitehub\/rpc\/__call$/)
    return sectionsMock()
  })
  return sectionsMock
}

afterEach(() => {
  for (const key of [consoleBuildKey, consoleBuildRootKey, consoleSectionsKey, consoleSectionsRootKey]) Reflect.deleteProperty(scope, key)
  for (const key of [consoleBuildKey, consoleBuildRegistryKey, consoleBuildRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey]) Reflect.deleteProperty(process, key)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("Console build id", () => {
  it("is the same for the same Console and changes when the Console catalog changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-build-"))
    try {
      const file = join(root, "console.mjs")
      const first = await generatedBuild(file, root, ["kv"])
      expect(await generatedBuild(file, root, ["kv"])).toBe(first)
      expect(await generatedBuild(file, root, ["kv", "blob"])).not.toBe(first)
      expect(await readFile(file, "utf8")).toContain(`import { installConsoleBuild, installConsolePageTool, installConsoleProjectName, installConsoleSections } from "vite-hub/console/sections"`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("is served with the sections of the active project", async () => {
    installConsoleSections("/first", ["kv"])
    installConsoleBuild("/first", "aaaaaaaaaaaaaaaa")
    installConsoleSections("/second", ["kv"])
    installConsoleBuild("/second", "bbbbbbbbbbbbbbbb")

    await expect(sectionsHandler(event())).resolves.toEqual({ build: "bbbbbbbbbbbbbbbb", sections: ["kv"] })
  })

  it("is read with the Console navigation", async () => {
    stubSections(["aaaaaaaaaaaaaaaa"])

    await expect(loadConsoleNavigation("/navigation-build/api/_vitehub/console/sections")).resolves.toMatchObject({ build: "aaaaaaaaaaaaaaaa" })
  })

  it("marks an update when the deployed build changes, on an interval and when the tab is visible again", async () => {
    vi.useFakeTimers()
    const document = stubDocument()
    const sectionsMock = stubSections(["first", "first", "second"])
    const updateReady = useConsoleUpdate()

    watchConsoleBuild("/watch-build/api/_vitehub/console/sections")
    await vi.waitFor(() => expect(sectionsMock).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(consoleBuildCheckInterval)
    expect(sectionsMock).toHaveBeenCalledTimes(2)
    expect(updateReady.value).toBe(false)

    // A tab that is visible again checks at once, but not right after another check.
    document.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(sectionsMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(10_000)
    document.show()
    await vi.waitFor(() => expect(updateReady.value).toBe(true))
    expect(sectionsMock).toHaveBeenCalledTimes(3)

    // After an update is found, the Console stops asking.
    await vi.advanceTimersByTimeAsync(consoleBuildCheckInterval * 3)
    expect(sectionsMock).toHaveBeenCalledTimes(3)
  })
})
