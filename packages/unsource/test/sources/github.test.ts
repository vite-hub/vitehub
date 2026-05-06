import { Buffer } from "node:buffer"

import { createMemoryStorage, setStorage } from "ocache"
import { afterEach, describe, expect, it, vi } from "vitest"

import { clearSources, github, registerSources, useSource } from "../../src/index.ts"
import { jsonResponse, stubGitHubSource } from "./fixtures/github.ts"

afterEach(() => {
  clearSources()
  setStorage(createMemoryStorage())
  vi.unstubAllGlobals()
})

describe("@vitehub/unsource GitHub source", () => {
  it("lists GitHub files under the configured root with relative keys", async () => {
    stubGitHubSource({
      "dbt/dbt_project.yml": "name: app\n",
      "dbt/models/marts/orders.sql": "select 1\n",
      "docs/README.md": "# Docs\n",
    })

    registerSources({ dbt: github({ repo: "acme/app", root: "dbt" }) })

    await expect(useSource("dbt").keys()).resolves.toEqual([
      "dbt_project.yml",
      "models/marts/orders.sql",
    ])
  })

  it("normalizes relative GitHub root paths before filtering tree entries", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
      "docs/guide.md": "# Guide\n",
    })

    registerSources({ docs: github({ repo: "acme/app", root: "./docs" }) })

    await expect(useSource("docs").keys()).resolves.toEqual([
      "README.md",
      "guide.md",
    ])
  })

  it("applies GitHub include and exclude filters to root-relative keys", async () => {
    stubGitHubSource({
      "dbt/models/marts/orders.sql": "select 1\n",
      "dbt/models/private/secret.sql": "select secret\n",
      "dbt/models/marts/orders.yml": "version: 2\n",
      "dbt/macros/date_spine.sql": "{% macro date_spine() %}{% endmacro %}\n",
    })

    registerSources({
      dbt: github({
        exclude: "models/private/**",
        include: ["models/**/*.sql", "macros/**/*.sql"],
        repo: "acme/app",
        root: "dbt",
      }),
    })

    await expect(useSource("dbt").keys()).resolves.toEqual([
      "models/marts/orders.sql",
      "macros/date_spine.sql",
    ])
  })

  it("falls back to GitHub archives when the tree API is rate limited", async () => {
    stubGitHubSource({
      "dbt/models/marts/orders.sql": "select 1\n",
      "docs/README.md": "# Docs\n",
    }, { apiStatus: 403 })

    registerSources({ dbt: github({ repo: "acme/app", root: "dbt" }) })

    const dbt = useSource("dbt")

    await expect(dbt.keys()).resolves.toEqual(["models/marts/orders.sql"])
    await expect(dbt.read("models/marts/orders.sql")).resolves.toBe("select 1\n")
  })

  it("sends GitHub auth on archive fallback requests", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    }, { apiStatus: 403 })

    registerSources({ docs: github({ auth: () => "github-token", repo: "acme/app", root: "docs" }) })

    await expect(useSource("docs").keys()).resolves.toEqual(["README.md"])

    const archiveCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).startsWith("https://codeload.github.com/"))
    expect((archiveCall?.[1]?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer github-token")
  })

  it("keys GitHub tree cache by the resolved auth token", async () => {
    let token = "first-token"
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization

      if (requestUrl.includes("/git/trees/")) {
        return jsonResponse({
          sha: "tree-sha",
          tree: [
            {
              path: authorization === "Bearer first-token" ? "first.md" : "second.md",
              type: "blob",
            },
          ],
        })
      }

      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    }))

    registerSources({ docs: github({ auth: () => token, repo: "acme/private" }) })

    await expect(useSource("docs").keys()).resolves.toEqual(["first.md"])

    token = "second-token"

    await expect(useSource("docs").keys()).resolves.toEqual(["second.md"])

    const treeCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/git/trees/"))
    expect(treeCalls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization)).toEqual([
      "Bearer first-token",
      "Bearer second-token",
    ])
  })

  it("uses the same GitHub auth token for item and content lookup", async () => {
    const tokens = ["first-token", "second-token"]
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization

      if (requestUrl.includes("/git/trees/")) {
        return jsonResponse({
          sha: "tree-sha",
          tree: [
            {
              path: authorization === "Bearer first-token" ? "first.md" : "second.md",
              type: "blob",
            },
          ],
        })
      }

      if (requestUrl.includes("/contents/first.md")) {
        expect(authorization).toBe("Bearer first-token")
        return jsonResponse({
          content: Buffer.from("first\n").toString("base64"),
          encoding: "base64",
        })
      }

      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    }))

    registerSources({ github: github({ auth: () => tokens.shift(), repo: "acme/private" }) })

    await expect(useSource("github").read("first.md")).resolves.toBe("first\n")

    const treeCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/git/trees/"))
    expect(treeCalls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization)).toEqual(["Bearer first-token"])
  })

  it("falls back to raw GitHub bytes when the contents API does not return base64", async () => {
    stubGitHubSource({ "metadata.xml": "<metadata />\n" })
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      if (requestUrl.includes("/git/trees/")) {
        return jsonResponse({
          sha: "tree-sha",
          tree: [{ path: "metadata.xml", type: "blob" }],
        })
      }
      if (requestUrl.includes("/contents/")) {
        return jsonResponse({ content: "", encoding: "none" })
      }
      if (requestUrl.startsWith("https://raw.githubusercontent.com/")) {
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer token")
        return new Response("<metadata />\n")
      }
      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    })

    registerSources({ github: github({ auth: () => "token", repo: "acme/app" }) })

    await expect(useSource("github").read("metadata.xml")).resolves.toBe("<metadata />\n")
  })

  it("dedupes cached GitHub tree and content reads", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    registerSources({
      docs: github({
        cache: { maxAge: 3600, swr: true },
        repo: "acme/app",
        root: "docs",
      }),
    })

    const docs = useSource("docs")

    await expect(Promise.all([
      docs.read("README.md"),
      docs.read("README.md"),
    ])).resolves.toEqual(["# Docs\n", "# Docs\n"])

    const treeCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/git/trees/"))
    const contentCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://raw.githubusercontent.com/"))
    expect(treeCalls).toHaveLength(1)
    expect(contentCalls).toHaveLength(1)
  })
})
