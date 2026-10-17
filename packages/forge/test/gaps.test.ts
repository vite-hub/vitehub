import { Buffer } from "node:buffer"

import { fixtureFetch } from "forges/testing"
import { describe, expect, it } from "vitest"

import { BranchMovedError, forgeArchive, forgeBlob, forgeCommitFiles, forgeGitAuthHeader, forgeGitCredentials, forgeProvider } from "../src/index.ts"

function repo(provider: Awaited<ReturnType<typeof forgeProvider>>, owner: string, name: string) {
  return { forge: provider.forge, instance: provider.instance, owner, name }
}

describe("forgeArchive", () => {
  it("follows the GitHub tarball redirect without sending the token to codeload", async () => {
    const archive = Buffer.from("tarball-bytes")
    const fixture = fixtureFetch([
      {
        request: { method: "GET", url: "https://api.github.com/repos/acme/app/tarball/feature/docs" },
        response: { status: 302, headers: { location: "https://codeload.github.com/acme/app/legacy.tar.gz/refs/heads/feature/docs?token=signed" } },
      },
      {
        request: { method: "GET", url: "https://codeload.github.com/acme/app/legacy.tar.gz/refs/heads/feature/docs?token=signed" },
        response: { status: 200, headers: { "content-type": "application/x-gzip" }, body: archive.toString("base64"), encoding: "base64" },
      },
    ])
    const provider = await forgeProvider({ forge: "github", token: "secret", fetch: fixture.fetch as typeof fetch })

    const stream = await forgeArchive(provider, repo(provider, "acme", "app"), { ref: "feature/docs" })

    expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(archive)
    expect(fixture.calls.map(call => [call.url, call.authorization])).toEqual([
      ["https://api.github.com/repos/acme/app/tarball/feature/docs", "Bearer secret"],
      ["https://codeload.github.com/acme/app/legacy.tar.gz/refs/heads/feature/docs?token=signed", undefined],
    ])
  })

  it("reads anonymous github.com archives from codeload so they do not use the API limit", async () => {
    const fixture = fixtureFetch([
      {
        request: { method: "GET", url: "https://codeload.github.com/acme/app/tar.gz/main" },
        response: { status: 200, body: Buffer.from("public").toString("base64"), encoding: "base64" },
      },
    ])
    const provider = await forgeProvider({ forge: "github", fetch: fixture.fetch as typeof fetch })

    const stream = await forgeArchive(provider, repo(provider, "acme", "app"), { ref: "main" })

    expect(Buffer.from(await new Response(stream).arrayBuffer()).toString()).toBe("public")
    expect(fixture.calls.map(call => [call.url, call.authorization])).toEqual([["https://codeload.github.com/acme/app/tar.gz/main", undefined]])
  })

  it("rejects with the Forge error status when the repository is missing", async () => {
    const fixture = fixtureFetch([
      {
        request: { method: "GET", url: "https://api.github.com/repos/acme/missing/tarball/main" },
        response: { status: 404, body: { message: "Not Found" } },
      },
    ])
    const provider = await forgeProvider({ forge: "github", token: "secret", fetch: fixture.fetch as typeof fetch })

    await expect(forgeArchive(provider, repo(provider, "acme", "missing"), { ref: "main" })).rejects.toMatchObject({ status: 404 })
  })

  it("rejects other Forges with FORGE_R0002", async () => {
    const fixture = fixtureFetch([])
    const provider = await forgeProvider({ forge: "gitlab", fetch: fixture.fetch as typeof fetch })

    await expect(forgeArchive(provider, repo(provider, "group", "app"), { ref: "main" })).rejects.toThrow("not supported for gitlab")
    expect(fixture.calls).toHaveLength(0)
  })
})

describe("forgeGitCredentials", () => {
  it.each([
    [{ forge: "github", repository: "acme/app", token: "t" }, { url: "https://github.com/acme/app.git", username: "x-access-token", password: "t" }],
    [{ forge: "github", baseUrl: "https://api.github.com", repository: "acme/app" }, { url: "https://github.com/acme/app.git" }],
    [{ forge: "github", baseUrl: "https://ghe.example.com/api/v3/", repository: "acme/app", token: "t" }, { url: "https://ghe.example.com/acme/app.git", username: "x-access-token", password: "t" }],
    [{ forge: "gitlab", repository: "group/sub/app", token: "t" }, { url: "https://gitlab.com/group/sub/app.git", username: "oauth2", password: "t" }],
    [{ forge: "gitlab", baseUrl: "https://git.example.com/gitlab/", repository: "group/app.git", token: "t" }, { url: "https://git.example.com/gitlab/group/app.git", username: "oauth2", password: "t" }],
    [{ forge: "forgejo", baseUrl: "https://forgejo.example.com", repository: "acme/app", token: "t" }, { url: "https://forgejo.example.com/acme/app.git", username: "oauth2", password: "t" }],
  ] as const)("builds the remote for %o", (input, expected) => {
    expect(forgeGitCredentials(input)).toEqual(expected)
  })

  it.each(["app", "acme/", "../app", "acme/a pp", "acme/app?x"])("rejects repository %s with FORGE_R0003", (repository) => {
    expect(() => forgeGitCredentials({ forge: "github", repository })).toThrow("must be owner/name")
  })

  it("scopes the basic auth header to the remote", () => {
    const credentials = forgeGitCredentials({ forge: "github", repository: "acme/app", token: "secret" })

    expect(forgeGitAuthHeader(credentials)).toEqual({
      key: "http.https://github.com/acme/app.git.extraheader",
      value: `AUTHORIZATION: basic ${Buffer.from("x-access-token:secret").toString("base64")}`,
    })
    expect(forgeGitAuthHeader(forgeGitCredentials({ forge: "github", repository: "acme/app" }))).toBeUndefined()
  })
})

interface RecordedCall {
  body?: unknown
  method: string
  path: string
}

/** A GitHub fake that answers `routes` by `METHOD path` and records each call. */
function githubRoutes(routes: Record<string, (call: RecordedCall) => Response>) {
  const calls: RecordedCall[] = []
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    const call = { body, method: (init.method ?? "GET").toUpperCase(), path: url.pathname }
    calls.push(call)
    const route = routes[`${call.method} ${call.path}`]
    return route ? route(call) : Response.json({ message: "Not Found" }, { status: 404 })
  }
  return { calls, fetch: fetch as typeof globalThis.fetch }
}

const parentSha = "a".repeat(40)
const movedSha = "b".repeat(40)

describe("forgeBlob", () => {
  it("reads the bytes of a blob by its sha", async () => {
    const fake = githubRoutes({
      "GET /repos/acme/app/git/blobs/abc": () => Response.json({ content: Buffer.from("target.md").toString("base64"), encoding: "base64", sha: "abc" }),
    })
    const provider = await forgeProvider({ forge: "github", token: "secret", fetch: fake.fetch })

    const bytes = await forgeBlob(provider, repo(provider, "acme", "app"), "abc")

    expect(Buffer.from(bytes).toString()).toBe("target.md")
  })

  it("rejects a malformed blob response", async () => {
    const fake = githubRoutes({ "GET /repos/acme/app/git/blobs/abc": () => Response.json({ sha: "abc" }) })
    const provider = await forgeProvider({ forge: "github", token: "secret", fetch: fake.fetch })

    await expect(forgeBlob(provider, repo(provider, "acme", "app"), "abc")).rejects.toThrow("malformed blob abc")
  })

  it("rejects other Forges with FORGE_R0004", async () => {
    const fake = githubRoutes({})
    const provider = await forgeProvider({ forge: "gitlab", fetch: fake.fetch })

    await expect(forgeBlob(provider, repo(provider, "group", "app"), "abc")).rejects.toThrow("not supported for gitlab")
    expect(fake.calls).toHaveLength(0)
  })
})

describe("forgeCommitFiles", () => {
  function commitRoutes(update: () => Response) {
    return githubRoutes({
      [`GET /repos/acme/app/git/commits/${parentSha}`]: () => Response.json({ sha: parentSha, tree: { sha: "base-tree" } }),
      "POST /repos/acme/app/git/blobs": () => Response.json({ sha: "new-blob" }, { status: 201 }),
      "POST /repos/acme/app/git/trees": () => Response.json({ sha: "new-tree" }, { status: 201 }),
      "POST /repos/acme/app/git/commits": () => Response.json({ sha: "new-commit" }, { status: 201 }),
      "PATCH /repos/acme/app/git/refs/heads/main": update,
      "GET /repos/acme/app/git/ref/heads/main": () => Response.json({ object: { sha: movedSha } }),
    })
  }

  it("writes Git file modes through the Git database and moves the branch without force", async () => {
    const fake = commitRoutes(() => Response.json({ object: { sha: "new-commit" } }))
    const provider = await forgeProvider({ forge: "github", token: "secret", fetch: fake.fetch })

    const sha = await forgeCommitFiles(provider, repo(provider, "acme", "app"), {
      branch: "main",
      changes: [
        { content: "target.md", mode: "120000", path: "link.md" },
        { content: "plain", path: "plain.md" },
        { content: null, path: "old.md" },
      ],
      expectedHead: parentSha,
      message: "write files",
    })

    expect(sha).toBe("new-commit")
    expect(fake.calls.find(call => call.method === "POST" && call.path.endsWith("/git/trees"))?.body).toEqual({
      base_tree: "base-tree",
      tree: [
        { mode: "120000", path: "link.md", sha: "new-blob", type: "blob" },
        { mode: "100644", path: "plain.md", sha: "new-blob", type: "blob" },
        { mode: "100644", path: "old.md", sha: null, type: "blob" },
      ],
    })
    expect(fake.calls.find(call => call.method === "PATCH")?.body).toEqual({ force: false, sha: "new-commit" })
  })

  it("rejects with BranchMovedError when the branch moved", async () => {
    const fake = commitRoutes(() => Response.json({ message: "Update is not a fast forward" }, { status: 422 }))
    const provider = await forgeProvider({ forge: "github", token: "secret", fetch: fake.fetch })

    await expect(forgeCommitFiles(provider, repo(provider, "acme", "app"), {
      branch: "main",
      changes: [{ content: "#!/bin/sh\n", mode: "100755", path: "tool.sh" }],
      expectedHead: parentSha,
      message: "write tool",
    })).rejects.toBeInstanceOf(BranchMovedError)
  })

  it("rejects file modes on other Forges with FORGE_R0005", async () => {
    const fake = githubRoutes({})
    const provider = await forgeProvider({ forge: "gitlab", token: "secret", fetch: fake.fetch })

    await expect(forgeCommitFiles(provider, repo(provider, "group", "app"), {
      branch: "main",
      changes: [{ content: "target", mode: "120000", path: "link" }],
      message: "write link",
    })).rejects.toThrow("Git file modes are not supported for gitlab")
    expect(fake.calls).toHaveLength(0)
  })
})
