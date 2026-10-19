import { Buffer } from "node:buffer"

import { fixtureFetch } from "forges/testing"
import { describe, expect, it } from "vitest"

import { forgeArchive, forgeGitAuthHeader, forgeGitCredentials, forgeProvider } from "../src/index.ts"

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
