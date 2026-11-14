import { describe, expect, it } from "vitest"

import { featureIds, features } from "../../internal/src/features.ts"
import { consoleAddablePrimitives, consoleAddCommand, consoleAddPrompt, groupConsolePrimitives } from "../src/console/runtime/client/add-primitive.ts"
import { consolePrimitives, resolveConsoleSectionIds } from "../src/console/runtime/sections.ts"

describe("Add a primitive", () => {
  it("offers the primitives that the app does not use, without the sections that come with Agents", () => {
    const ids = consoleAddablePrimitives(["comments", "content", "agents", "skills", "usage", "channels"]).map(entry => entry.id)
    expect(ids).not.toContain("comments")
    expect(ids).not.toContain("content")
    expect(ids).not.toContain("agents")
    for (const id of ["channels", "skills", "usage"]) expect(consoleAddablePrimitives([]).map(entry => entry.id)).not.toContain(id)
    expect(ids).toEqual(expect.arrayContaining(["kv", "databases", "auth", "workflows"]))
  })

  it("groups the primitives in sidebar order and drops empty groups", () => {
    const groups = groupConsolePrimitives(consoleAddablePrimitives([]))
    expect(groups.map(group => group.label)).toEqual(["Site", "Data", "Users", "AI", "Runtime"])
    expect(groups.find(group => group.id === "site")?.primitives.map(entry => entry.id)).toEqual(["content", "comments"])

    const data = groupConsolePrimitives(consoleAddablePrimitives(["content", "comments"]))
    expect(data[0]?.label).toBe("Data")
  })

  it("filters by name, description, and feature id, with every word of the query", () => {
    const all = consoleAddablePrimitives([])
    expect(groupConsolePrimitives(all, "KV").flatMap(group => group.primitives.map(entry => entry.id))).toEqual(["kv"])
    expect(groupConsolePrimitives(all, "  cron  ").flatMap(group => group.primitives.map(entry => entry.id))).toEqual(["schedules"])
    expect(groupConsolePrimitives(all, "ratelimit").flatMap(group => group.primitives.map(entry => entry.id))).toEqual(["rate-limits"])
    expect(groupConsolePrimitives(all, "store key").flatMap(group => group.primitives.map(entry => entry.id))).toEqual(["kv"])
    expect(groupConsolePrimitives(all, "no such primitive")).toEqual([])
  })

  it("names a feature of `vitehub add` that turns the section on", () => {
    const withFeature = consolePrimitives.filter(entry => entry.feature)
    expect(withFeature.length).toBeGreaterThan(10)
    for (const entry of withFeature) {
      expect(featureIds).toContain(entry.feature)
      // `vitehub add` writes `<feature>: true`, or `{}` for Env.
      expect(resolveConsoleSectionIds({ [entry.feature!]: entry.feature === "env" ? {} : true }), entry.id).toContain(entry.id)
      expect(entry.docs).toBe(`https://vitehub.dev${features[entry.feature!].docs}`)
    }
    expect(consolePrimitives.find(entry => entry.id === "content")?.feature).toBeUndefined()
  })

  it("gives a command that `vitehub add` reads, and a prompt with the docs", () => {
    const rateLimits = consolePrimitives.find(entry => entry.id === "rate-limits")!
    expect(consoleAddCommand(rateLimits)).toBe("npx vitehub add rate-limit")
    expect(consoleAddCommand(consolePrimitives.find(entry => entry.id === "sandbox-tasks")!)).toBe("npx vitehub add sandbox-task")
    // `readFeatureId` in `@vite-hub/cli` drops dashes and ignores case.
    for (const entry of consolePrimitives.filter(item => item.feature)) {
      const argument = consoleAddCommand(entry)!.split(" ").at(-1)!
      expect(argument.replaceAll("-", "")).toBe(entry.feature!.toLowerCase())
    }

    expect(consoleAddPrompt(rateLimits)).toBe("Add the ViteHub Rate Limits primitive to this app. Run `npx vitehub add rate-limit --dry-run` to see the change, then run it again with `--yes` to apply it. Follow https://vitehub.dev/docs/rate-limit")
    const content = consolePrimitives.find(entry => entry.id === "content")!
    expect(consoleAddCommand(content)).toBeUndefined()
    expect(consoleAddPrompt(content)).toBe("Add the ViteHub Content primitive to this app. Follow https://vitehub.dev/docs/content")
  })
})
