import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import { collectContributions, describeContribution } from "../src/contributions.ts"

import type { ContributingPlugin, ContributionContext } from "../src/contributions.ts"

const context: ContributionContext = { projectRoot: "/app", root: "/app/src", serverDirs: ["/app/server"] }

function errors() {
  return {
    duplicate: (message: string) => new Error(`DUPLICATE ${message}`),
    invalid: (message: string) => new Error(`INVALID ${message}`),
  }
}

function collect(plugins: readonly unknown[]) {
  return collectContributions(plugins, { context, key: "widgets", kind: "Widget", ...errors() })
}

describe("collectContributions", () => {
  it("reads arrays and factories and returns entries sorted by name", async () => {
    const contexts: ContributionContext[] = []
    const plugins: Array<ContributingPlugin<"widgets">> = [
      { name: "b-plugin", vitehub: { widgets: [{ definition: { module: "/b/zeta.ts" }, name: "zeta" }] } },
      {
        name: "a-plugin",
        vitehub: {
          widgets: async (received) => {
            contexts.push(received)
            return [{ definition: { export: "alpha", module: "pkg/widgets" }, name: "alpha", reason: "Adds alpha." }]
          },
        },
      },
    ]

    await expect(collect(plugins)).resolves.toEqual([
      { definition: { export: "alpha", module: "pkg/widgets" }, name: "alpha", plugin: "a-plugin", reason: "Adds alpha." },
      { definition: { export: "default", module: "/b/zeta.ts" }, name: "zeta", plugin: "b-plugin" },
    ])
    expect(contexts).toEqual([context])
  })

  it("returns the same order when plugins are registered in another order", async () => {
    const first = { name: "first", vitehub: { widgets: [{ definition: { module: "/one.ts" }, name: "b" }] } }
    const second = { name: "second", vitehub: { widgets: [{ definition: { module: "/two.ts" }, name: "a" }] } }

    const forward = await collect([first, second])
    const reverse = await collect([second, first])
    expect(forward).toEqual(reverse)
    expect(forward.map(contribution => contribution.name)).toEqual(["a", "b"])
  })

  it("flattens nested and promised plugin options and skips plugins without the key", async () => {
    const nested = { name: "nested", vitehub: { widgets: [{ definition: { module: "/nested.ts" }, name: "nested" }] } }
    const promised = Promise.resolve({ name: "promised", vitehub: { widgets: [{ definition: { module: "/promised.ts" }, name: "promised" }] } })

    const collected = await collect([null, false, { name: "plain" }, { name: "other", vitehub: { inspect: {} } }, [[nested]], promised])
    expect(collected.map(contribution => contribution.plugin)).toEqual(["nested", "promised"])
  })

  it("keeps one entry when the same plugin is registered twice", async () => {
    const plugin = () => ({ name: "twice", vitehub: { widgets: [{ definition: { module: "/twice.ts" }, name: "twice" }] } })

    await expect(collect([plugin(), plugin()])).resolves.toHaveLength(1)
  })

  it("fails on one name from two plugins and names both plugins", async () => {
    const plugins = [
      { name: "first-plugin", vitehub: { widgets: [{ definition: { module: "/first.ts" }, name: "docs" }] } },
      { name: "second-plugin", vitehub: { widgets: [{ definition: { export: "docs", module: "pkg/second" }, name: "docs" }] } },
    ]

    const error = await collect(plugins).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("DUPLICATE [vitehub] Widget \"docs\" is contributed more than once")
    expect(String(error)).toContain("/first.ts from plugin \"first-plugin\"")
    expect(String(error)).toContain("pkg/second#docs from plugin \"second-plugin\"")
  })

  it("fails on one name from two plugins with the same entry", async () => {
    const entry = { definition: { module: "/same.ts" }, name: "same" }

    await expect(collect([{ name: "one", vitehub: { widgets: [entry] } }, { name: "two", vitehub: { widgets: [entry] } }]))
      .rejects.toThrow(/plugin "one"[\s\S]*plugin "two"/)
  })

  it("normalizes file URLs and rejects relative modules", async () => {
    const file = pathToFileURL("/app/widgets/docs.ts").href
    const [collected] = await collect([{ name: "url", vitehub: { widgets: [{ definition: { module: file }, name: "docs" }] } }])
    expect(collected?.definition.module).toBe("/app/widgets/docs.ts")

    await expect(collect([{ name: "relative", vitehub: { widgets: [{ definition: { module: "./docs.ts" }, name: "docs" }] } }]))
      .rejects.toThrow("INVALID [vitehub] Plugin \"relative\" contributed an invalid Widget: `definition.module` of Widget \"docs\" is relative")
  })

  it.each([
    [{ definition: { module: "/a.ts" } }, "`name` must be a non-empty string"],
    [{ definition: { module: "/a.ts" }, name: " padded " }, "`name` must be a non-empty string"],
    [{ name: "flat", module: "/a.ts" }, "needs `definition: { module, export? }`"],
    [{ definition: { module: "" }, name: "empty" }, "`definition.module` of Widget \"empty\" must be a non-empty string"],
    [{ definition: { export: "", module: "/a.ts" }, name: "export" }, "`definition.export` of Widget \"export\" must be a non-empty string"],
    [{ definition: { module: "/a.ts" }, name: "reason", reason: "" }, "`reason` of Widget \"reason\" must be a non-empty string"],
    ["not an entry", "expected { name, definition: { module, export? }, reason? }"],
  ])("rejects an invalid entry %#", async (entry, message) => {
    await expect(collect([{ name: "bad", vitehub: { widgets: [entry] } }])).rejects.toThrow(message)
  })

  it("rejects a value that is not an array and skips a factory that returns undefined", async () => {
    await expect(collect([{ name: "object", vitehub: { widgets: { name: "x" } } }]))
      .rejects.toThrow("`vitehub.widgets` must be an array or a function that returns one.")
    await expect(collect([{ name: "nothing", vitehub: { widgets: () => undefined } }])).resolves.toEqual([])
  })

  it("applies owner name rules and owner fields", async () => {
    const collected = await collectContributions([
      { name: "owner", vitehub: { widgets: [{ database: "main", definition: { module: "/tables.ts" }, name: "history" }] } },
    ], {
      checkName: name => /^[a-z]+$/.test(name) ? undefined : "use lowercase letters.",
      context,
      fields: (entry, fail) => {
        const { database } = entry
        if (database !== undefined && String(database) !== database) fail("`database` must be a string.")
        return database === undefined ? {} : { database: String(database) }
      },
      key: "widgets",
      kind: "Widget",
      ...errors(),
    })
    expect(collected).toEqual([{ database: "main", definition: { export: "default", module: "/tables.ts" }, name: "history", plugin: "owner" }])

    await expect(collect([{ name: "owner", vitehub: { widgets: [{ definition: { module: "/a.ts" }, name: "Upper" }] } }])).resolves.toHaveLength(1)
    await expect(collectContributions([{ name: "owner", vitehub: { widgets: [{ definition: { module: "/a.ts" }, name: "Upper" }] } }], {
      checkName: name => /^[a-z]+$/.test(name) ? undefined : "use lowercase letters.",
      context,
      key: "widgets",
      kind: "Widget",
      ...errors(),
    })).rejects.toThrow("Widget \"Upper\": use lowercase letters.")
  })

  it("describes a contribution with its export and plugin", () => {
    expect(describeContribution({ definition: { export: "default", module: "/a.ts" }, plugin: "p" })).toBe("/a.ts from plugin \"p\"")
    expect(describeContribution({ definition: { export: "named", module: "pkg" }, plugin: "p" })).toBe("pkg#named from plugin \"p\"")
  })
})
