import { afterEach, describe, expect, it, vi } from "vitest"

import { github } from "../../src/github.ts"
import { createSource } from "../../src/index.ts"
import { requestAuthorization, stubGitHubSource } from "./fixtures/github.ts"

afterEach(() => vi.unstubAllGlobals())

describe.each([false, true])("GitHub Source reader credentials with cache=%s", (cached) => {
  it.each(["keys", "meta", "read"] as const)("keeps an anonymous reader anonymous during %s", async (operation) => {
    stubGitHubSource({ "README.md": "# Readme\n" })
    let token: string | undefined
    const source = github({
      auth: () => token,
      cache: cached ? { maxAge: 3600 } : false,
      ref: "main",
      repo: `acme/auth-${operation}-${cached}`,
    })
    const anonymous = createSource(source, { abortSignal: new AbortController().signal })
    await anonymous.revision()

    token = "another-reader-token"
    const authenticated = createSource(source)
    await authenticated.revision()
    vi.mocked(fetch).mockClear()

    if (operation === "keys") await anonymous.keys()
    else if (operation === "meta") await anonymous.meta("README.md")
    else await anonymous.read("README.md")

    const authorizations = vi.mocked(fetch).mock.calls.map(([, init]) => requestAuthorization(init))
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations).toEqual(authorizations.map(() => undefined))

    vi.mocked(fetch).mockClear()
    await authenticated.meta("README.md")
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => requestAuthorization(init)))
      .toEqual(["Bearer another-reader-token"])
  })

  it.each(["keys", "meta", "read"] as const)("preserves a supplied-revision reader's credentials during %s", async (operation) => {
    stubGitHubSource({ "README.md": "# Readme\n", "other.md": "Other\n" })
    let token: string | undefined
    const auth = vi.fn(() => token)
    const source = github({
      auth,
      cache: cached ? { maxAge: 3600 } : false,
      repo: `acme/pinned-auth-${operation}-${cached}`,
    })
    const revision = { id: "pinned-commit", immutable: true }
    const anonymous = createSource(source, { revision, abortSignal: new AbortController().signal })
    await anonymous.meta("other.md")

    token = "another-reader-token"
    const authenticated = createSource(source, { revision })
    await authenticated.meta("other.md")
    vi.mocked(fetch).mockClear()

    if (operation === "keys") await anonymous.keys()
    else if (operation === "meta") await anonymous.meta("README.md")
    else await anonymous.read("README.md")

    const authorizations = vi.mocked(fetch).mock.calls.map(([, init]) => requestAuthorization(init))
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations).toEqual(authorizations.map(() => undefined))

    token = "later-token"
    vi.mocked(fetch).mockClear()
    await authenticated.meta("README.md")
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => requestAuthorization(init)))
      .toEqual(["Bearer another-reader-token"])
    expect(auth).toHaveBeenCalledTimes(2)
  })

  it("shares credential capture between concurrent supplied-revision operations", async () => {
    stubGitHubSource({ "README.md": "Readme", "other.md": "Other" })
    const auth = vi.fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue("another-reader-token")
    const source = github({
      auth,
      cache: cached ? { maxAge: 3600 } : false,
      repo: `acme/concurrent-pinned-auth-${cached}`,
    })
    const reader = createSource(source, { revision: { id: "pinned-commit", immutable: true } })
    await Promise.all([reader.meta("README.md"), reader.meta("other.md")])

    expect(auth).toHaveBeenCalledTimes(1)
    const authorizations = vi.mocked(fetch).mock.calls.map(([, init]) => requestAuthorization(init))
    expect(authorizations).toEqual([undefined, undefined])
  })
})
