import { createMemoryStorage, setStorage } from "ocache"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { github } from "../../src/github.ts"
import { clearSources, registerSources, useSource } from "../../src/index.ts"
import { createGitHubCacheKey, githubAuthenticationScope } from "../../src/sources/github/cache.ts"
import { createTarGz, jsonResponse, stubGitHubSource } from "./fixtures/github.ts"

const loadGitArchiveFiles = vi.hoisted(() => vi.fn())

vi.mock("../../src/sources/github/git.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/sources/github/git.ts")>(),
  loadGitArchiveFiles,
}))

beforeEach(() => {
  loadGitArchiveFiles.mockReset()
  loadGitArchiveFiles.mockRejectedValue(new Error("git unavailable"))
})

afterEach(() => {
  clearSources()
  setStorage(createMemoryStorage())
  vi.unstubAllGlobals()
})

describe("@vite-hub/source GitHub source", () => {
  it("keeps credentials out of GitHub cache keys", () => {
    const key = createGitHubCacheKey({
      authScope: githubAuthenticationScope("github-secret"),
      kind: "archive",
      ref: "main",
      repo: "acme/private",
      root: "",
    })
    expect(key).not.toContain("github-secret")
    expect(key).not.toBe(createGitHubCacheKey({
      authScope: githubAuthenticationScope("another-secret"),
      kind: "archive",
      ref: "main",
      repo: "acme/private",
      root: "",
    }))
  })

  it("pins a configured branch to one inspected revision", async () => {
    stubGitHubSource({ "README.md": "# Readme\n" })
    registerSources({ docs: github({ ref: "main", repo: "acme/app" }) })

    const docs = useSource("docs")
    await expect(docs.revision()).resolves.toEqual({
      id: "latest-commit-sha",
      immutable: true,
      ref: "main",
    })
    await expect(docs.read("README.md")).resolves.toBe("# Readme\n")
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/tar.gz/latest-commit-sha"))).toBe(true)
  })

  it("materializes simple GitHub source paths with git", async () => {
    vi.stubGlobal("fetch", vi.fn())
    loadGitArchiveFiles.mockResolvedValueOnce([
      {
        content: new TextEncoder().encode("# Docs\n"),
        key: "docs/README.md",
        path: "docs/README.md",
        ref: "main",
        sha: "checkout-sha",
      },
    ])

    const docs = github({
      auth: () => "github-token",
      include: ["docs/**"],
      ref: "main",
      repo: "acme/app",
    })

    await expect(docs.getItems?.({ rootDir: process.cwd() })).resolves.toEqual([
      {
        content: new TextEncoder().encode("# Docs\n"),
        key: "docs/README.md",
        metadata: { ref: "main", sha: "checkout-sha" },
        path: "docs/README.md",
      },
    ])
    expect(loadGitArchiveFiles).toHaveBeenCalledWith(expect.objectContaining({
      ref: "main",
      repo: "acme/app",
      sparsePatterns: ["docs/**"],
      token: "github-token",
    }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it("shares git materialization while callers cancel independently", async () => {
    vi.stubGlobal("fetch", vi.fn())
    let finishMaterialization!: () => void
    loadGitArchiveFiles.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishMaterialization = resolve
      })
      return [{
        content: new TextEncoder().encode("# Docs\n"),
        key: "docs/README.md",
        path: "docs/README.md",
        ref: "main",
        sha: "checkout-sha",
      }]
    })
    const docs = github({ include: ["docs/**"], ref: "main", repo: "acme/app" })
    const alreadyCanceled = new AbortController()
    const canceled = new AbortController()
    const active = new AbortController()

    alreadyCanceled.abort()
    await expect(docs.getKeys({ abortSignal: alreadyCanceled.signal, rootDir: process.cwd() })).rejects.toMatchObject({ name: "AbortError" })
    expect(loadGitArchiveFiles).not.toHaveBeenCalled()

    const canceledKeys = docs.getKeys({ abortSignal: canceled.signal, rootDir: process.cwd() })
    const activeKeys = docs.getKeys({ abortSignal: active.signal, rootDir: process.cwd() })
    await vi.waitFor(() => expect(finishMaterialization).toBeTypeOf("function"))
    canceled.abort()

    await expect(canceledKeys).rejects.toMatchObject({ name: "AbortError" })
    finishMaterialization()
    await expect(activeKeys).resolves.toEqual(["docs/README.md"])

    expect(loadGitArchiveFiles).toHaveBeenCalledOnce()
    expect(loadGitArchiveFiles).toHaveBeenCalledWith(expect.objectContaining({ signal: undefined }))
  })

  it("pins cached default-ref git materialization to the resolved commit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl === "https://api.github.com/repos/acme/app") {
        return jsonResponse({ default_branch: "main" })
      }
      if (requestUrl.endsWith("/commits/main")) {
        return jsonResponse({ sha: "first-commit" })
      }
      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    }))
    loadGitArchiveFiles.mockImplementationOnce(async input => [{
      content: new TextEncoder().encode("first\n"),
      key: "README.md",
      path: "README.md",
      ref: input.ref,
      sha: "first-commit",
    }])

    const source = github({
      cache: { maxAge: 3600 },
      include: "README.md",
      repo: "acme/app",
    })

    await expect(source.getKeys({ abortSignal: new AbortController().signal, rootDir: process.cwd() })).resolves.toEqual(["README.md"])
    await expect(source.getItems?.({ abortSignal: new AbortController().signal, rootDir: process.cwd() })).resolves.toEqual([{
      content: new TextEncoder().encode("first\n"),
      key: "README.md",
      metadata: { ref: "first-commit", sha: "first-commit" },
      path: "README.md",
    }])
    expect(loadGitArchiveFiles).toHaveBeenCalledOnce()
    expect(loadGitArchiveFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: "first-commit" }))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/commits/main"))).toHaveLength(1)
  })

  it("falls back to the GitHub archive when git materialization fails", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    const docs = github({ ref: "main", repo: "acme/app", root: "docs" })

    await expect(docs.getKeys({ rootDir: process.cwd() })).resolves.toEqual(["README.md"])
    expect(loadGitArchiveFiles).toHaveBeenCalledOnce()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))).toHaveLength(1)
  })

  it("uses the GitHub archive directly for unsupported sparse patterns", async () => {
    stubGitHubSource({
      "docs/guides/setup.md": "# Setup\n",
    })

    const docs = github({ include: "docs/**/*.md", ref: "main", repo: "acme/app" })

    await expect(docs.getKeys({ rootDir: process.cwd() })).resolves.toEqual(["docs/guides/setup.md"])
    expect(loadGitArchiveFiles).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))).toHaveLength(1)
  })

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

  it("uses GitHub archives when the API is rate limited", async () => {
    stubGitHubSource({
      "dbt/models/marts/orders.sql": "select 1\n",
      "docs/README.md": "# Docs\n",
    }, { apiStatus: 403 })

    registerSources({ dbt: github({ repo: "acme/app", root: "dbt" }) })

    const dbt = useSource("dbt")

    await expect(dbt.keys()).resolves.toEqual(["models/marts/orders.sql"])
    await expect(dbt.read("models/marts/orders.sql")).resolves.toBe("select 1\n")
  })

  it("uses GitHub archives for source snapshots", async () => {
    stubGitHubSource({
      "dbt/models/marts/orders.sql": "select 1\n",
      "docs/README.md": "# Docs\n",
    }, { treeTruncated: true })

    registerSources({ dbt: github({ repo: "acme/app", root: "dbt" }) })

    await expect(useSource("dbt").keys()).resolves.toEqual(["models/marts/orders.sql"])
    await expect(useSource("dbt").read("models/marts/orders.sql")).resolves.toBe("select 1\n")
  })

  it("reads a single GitHub file through the contents API without downloading the archive", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
      "docs/guide.md": "# Guide\n",
    })

    const docs = github({ repo: "acme/app", root: "docs" })

    await expect(docs.getItem("README.md", {
      abortSignal: new AbortController().signal,
      rootDir: process.cwd(),
    })).resolves.toMatchObject({
      content: new TextEncoder().encode("# Docs\n"),
      key: "README.md",
    })

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    const contentsCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/contents/docs/README.md"))
    expect(archiveCalls).toHaveLength(0)
    expect(contentsCalls).toHaveLength(1)
  })

  it("reads GitHub file metadata through the contents API without downloading the archive", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
      "docs/guide.md": "# Guide\n",
    })

    const docs = github({ repo: "acme/app", root: "docs" })

    await expect(docs.getMeta?.("README.md", { abortSignal: new AbortController().signal, rootDir: process.cwd() })).resolves.toEqual({
      ref: "latest-commit-sha",
      sha: "sha-docs/README.md",
    })

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    const contentsCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/contents/docs/README.md"))
    expect(archiveCalls).toHaveLength(0)
    expect(contentsCalls).toHaveLength(1)
  })

  it("caches GitHub metadata reads when provider cache is configured", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
      "docs/guide.md": "# Guide\n",
    })

    const docs = github({ cache: { maxAge: 3600 }, repo: "acme/app", root: "docs" })

    await expect(docs.getMeta?.("README.md", { abortSignal: new AbortController().signal, rootDir: process.cwd() })).resolves.toEqual({
      ref: "latest-commit-sha",
      sha: "sha-docs/README.md",
    })
    await expect(docs.getMeta?.("README.md", { abortSignal: new AbortController().signal, rootDir: process.cwd() })).resolves.toEqual({
      ref: "latest-commit-sha",
      sha: "sha-docs/README.md",
    })

    const contentsCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/contents/docs/README.md"))
    expect(contentsCalls).toHaveLength(1)
  })

  it("falls back to GitHub archive metadata when the contents API is rate limited", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    }, { apiStatus: 403 })

    const docs = github({ repo: "acme/app", root: "docs" })

    await expect(docs.getMeta?.("README.md", { rootDir: process.cwd() })).resolves.toEqual({
      ref: "main",
      sha: "main",
    })

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    expect(archiveCalls).toHaveLength(1)
  })

  it("does not hide invalid GitHub refs as missing metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.includes("/contents/") || requestUrl.endsWith("/commits/missing-ref")) {
        return jsonResponse({ message: "not found" }, 404)
      }
      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    }))

    const docs = github({ ref: "missing-ref", repo: "acme/app", root: "docs" })

    await expect(docs.getMeta?.("README.md", { rootDir: process.cwd() }))
      .rejects.toThrow("could not access the repository or ref")
  })

  it("returns missing GitHub metadata from the abort-signal contents path after validating the ref", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.endsWith("/commits/main")) return jsonResponse({ sha: "latest-commit-sha" })
      if (requestUrl.includes("/contents/docs/missing.md")) return new Response("not found", { status: 404 })
      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    }))

    const docs = github({ ref: "main", repo: "acme/app", root: "docs" })

    await expect(docs.getMeta?.("missing.md", {
      abortSignal: new AbortController().signal,
      rootDir: process.cwd(),
    })).resolves.toBeUndefined()

    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/acme/app/contents/docs/missing.md?ref=main",
      "https://api.github.com/repos/acme/app/commits/main",
    ])
  })

  it("rejects invalid GitHub refs from the abort-signal metadata path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.includes("/contents/docs/README.md")) return new Response("not found", { status: 404 })
      if (requestUrl.endsWith("/commits/missing-ref")) return new Response("not found", { status: 404 })
      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    }))

    const docs = github({ ref: "missing-ref", repo: "acme/app", root: "docs" })

    await expect(docs.getMeta?.("README.md", {
      abortSignal: new AbortController().signal,
      rootDir: process.cwd(),
    })).rejects.toThrow("could not access the repository or ref")
  })

  it("reads non-ASCII paths from GitHub archive PAX headers", async () => {
    stubGitHubSource({
      "docs/café.md": "# Café\n",
    }, { apiStatus: 403 })

    registerSources({ docs: github({ repo: "acme/app", root: "docs" }) })

    await expect(useSource("docs").keys()).resolves.toEqual(["café.md"])
    await expect(useSource("docs").read("café.md" as any)).resolves.toBe("# Café\n")
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

  it("omits GitHub auth when auth is explicitly false", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    }, { apiStatus: 403 })

    registerSources({ docs: github({ auth: false, repo: "acme/app", root: "docs" }) })

    await expect(useSource("docs").keys()).resolves.toEqual(["README.md"])

    const headers = vi.mocked(fetch).mock.calls.map(([, init]) => init?.headers as Record<string, string> | undefined)
    expect(headers.every(header => header?.authorization === undefined)).toBe(true)
  })

  it("keys GitHub archive cache by the resolved auth token", async () => {
    let token = "first-token"
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization

      if (requestUrl === "https://api.github.com/repos/acme/private") {
        return jsonResponse({ default_branch: "main" })
      }

      if (requestUrl.endsWith("/commits/main")) {
        return jsonResponse({ sha: authorization === "Bearer first-token" ? "first-commit" : "second-commit" })
      }

      if (requestUrl.startsWith("https://codeload.github.com/")) {
        const file = authorization === "Bearer first-token" ? "first.md" : "second.md"
        return new Response(createTarGz({ [file]: `${file}\n` }))
      }

      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    }))

    registerSources({ docs: github({ auth: () => token, repo: "acme/private" }) })

    await expect(useSource("docs").keys()).resolves.toEqual(["first.md"])

    token = "second-token"

    await expect(useSource("docs").keys()).resolves.toEqual(["second.md"])

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    expect(archiveCalls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization)).toEqual([
      "Bearer first-token",
      "Bearer second-token",
    ])
  })

  it("reuses the loaded GitHub archive entry for item content", async () => {
    const tokens = ["first-token", "second-token"]
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization

      if (requestUrl === "https://api.github.com/repos/acme/private") {
        return jsonResponse({ default_branch: "main" })
      }

      if (requestUrl.endsWith("/commits/main")) {
        return jsonResponse({ sha: "first-commit" })
      }

      if (requestUrl.startsWith("https://codeload.github.com/")) {
        expect(authorization).toBe("Bearer first-token")
        return new Response(createTarGz({ "first.md": "first\n" }))
      }

      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    }))

    registerSources({ github: github({ auth: () => tokens.shift(), repo: "acme/private" }) })

    await expect(useSource("github").read("first.md")).resolves.toBe("first\n")

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    expect(archiveCalls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization)).toEqual([
      "Bearer first-token",
    ])
    expect(tokens).toEqual(["second-token"])
  })

  it("reads GitHub bytes from archive snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn())
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      if (requestUrl === "https://api.github.com/repos/acme/app") {
        return jsonResponse({ default_branch: "main" })
      }
      if (requestUrl.endsWith("/commits/main")) {
        return jsonResponse({ sha: "latest-commit-sha" })
      }
      if (requestUrl.startsWith("https://codeload.github.com/")) {
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer token")
        return new Response(createTarGz({ "metadata.xml": "<metadata />\n" }))
      }
      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    })

    registerSources({ github: github({ auth: () => "token", repo: "acme/app" }) })

    await expect(useSource("github").read("metadata.xml")).resolves.toBe("<metadata />\n")
  })

  it("dedupes cached GitHub archive reads", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    registerSources({
      docs: github({
        cache: { maxAge: 3600 },
        repo: "acme/app",
        root: "docs",
      }),
    })

    const docs = useSource("docs")

    await expect(Promise.all([
      docs.read("README.md"),
      docs.read("README.md"),
    ])).resolves.toEqual(["# Docs\n", "# Docs\n"])

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    expect(archiveCalls).toHaveLength(1)
  })

  it("dedupes concurrent GitHub archive reads without provider cache", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    registerSources({
      docs: github({
        repo: "acme/app",
        root: "docs",
      }),
    })

    const docs = useSource("docs")

    await expect(Promise.all([
      docs.read("README.md"),
      docs.read("README.md"),
    ])).resolves.toEqual(["# Docs\n", "# Docs\n"])

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    expect(archiveCalls).toHaveLength(1)
  })

  it("does not cache completed GitHub archive reads without provider cache", async () => {
    const archives = [
      createTarGz({ "docs/README.md": "first\n" }),
      createTarGz({ "docs/README.md": "second\n" }),
    ]

    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl.startsWith("https://codeload.github.com/")) {
        const archive = archives.shift()
        if (!archive) throw new Error("Unexpected extra GitHub archive request")
        return new Response(archive)
      }
      if (requestUrl.endsWith("/commits/main")) return jsonResponse({ sha: "revision-1" })
      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    }))

    registerSources({
      docs: github({
        ref: "main",
        repo: "acme/app",
        root: "docs",
      }),
    })

    const docs = useSource("docs")

    await expect(docs.read("README.md")).resolves.toBe("first\n")
    await expect(docs.read("README.md")).resolves.toBe("second\n")

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    expect(archiveCalls).toHaveLength(2)
  })
})
