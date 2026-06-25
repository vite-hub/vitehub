import { generateKeyPairSync } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

describe("agent channels", () => {
  it("publishes explicit Workspace artifacts", async () => {
    const { publishWorkspaceArtifacts } = await import("../src/channels.ts")
    const content = new Uint8Array([1, 2, 3])
    const readFile = vi.fn(async () => content)
    const stat = vi.fn(async () => ({ mediaType: "image/png", path: "screenshots/login.png", type: "file" as const }))
    const publish = vi.fn(async () => ({ url: "https://assets.example/review/screenshots/login.png" }))

    await expect(publishWorkspaceArtifacts({
      workspace: {
        fs: { readFile, stat },
      } as never,
    }, [{
      alt: "Login badge",
      path: "./screenshots/login.png",
      placement: "inline",
    }], {
      prefix: "review",
      publish,
    })).resolves.toEqual([{
      alt: "Login badge",
      mediaType: "image/png",
      path: "screenshots/login.png",
      placement: "inline",
      url: "https://assets.example/review/screenshots/login.png",
    }])

    expect(readFile).toHaveBeenCalledWith("screenshots/login.png", { encoding: "binary" })
    expect(publish).toHaveBeenCalledWith({
      artifact: {
        alt: "Login badge",
        mediaType: "image/png",
        path: "screenshots/login.png",
        placement: "inline",
      },
      content,
      mediaType: "image/png",
      pathname: "review/screenshots/login.png",
    })
  })

  it("rejects unsafe Workspace artifact paths before publishing", async () => {
    const { publishWorkspaceArtifacts } = await import("../src/channels.ts")
    const publish = vi.fn()

    await expect(publishWorkspaceArtifacts({
      workspace: {
        fs: {
          readFile: vi.fn(),
          stat: vi.fn(),
        },
      } as never,
    }, [{ path: "../secret.png" }], { publish })).rejects.toThrow("Delivery artifact path must stay inside the workspace")
    expect(publish).not.toHaveBeenCalled()
  })

  it("posts GitHub PR reviews with inline published image artifacts", async () => {
    const { github } = await import("../src/channels.ts")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" }).toString()
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return Response.json({ expires_at: new Date(Date.now() + 600_000).toISOString(), token: "installation-token" })
      }
      return Response.json({ ok: true }, { status: 201 })
    })
    const channel = github({
      app: {
        apiBaseUrl: "https://api.github.test",
        appId: "1",
        fetch: fetcher as typeof fetch,
        installationId: 123,
        privateKey: privateKeyPem,
      },
    })
    const reviewEffect = channel.effects?.review
    if (typeof reviewEffect !== "function") throw new Error("Missing GitHub review effect.")

    await reviewEffect({
      channel,
      effect: {
        artifacts: [{
          alt: "Login badge",
          mediaType: "image/png",
          path: "screenshots/login.png",
          placement: "inline",
          url: "https://assets.example/review/screenshots/login.png",
        }],
        kind: "review",
        payload: { body: "Review body" },
      },
      input: {
        context: {
          github: {
            action: "created",
            actor: { login: "onmax" },
            args: "",
            body: "/review",
            command: "/review",
            commentId: 99,
            installationId: 123,
            issueNumber: 42,
            owner: "vite-hub",
            pullRequestUrl: "https://api.github.test/repos/vite-hub/vitehub/pulls/42",
            repo: "vitehub",
            repository: "vite-hub/vitehub",
          },
        },
        prompt: "/review",
      },
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    } as never)

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.test/repos/vite-hub/vitehub/pulls/42/reviews",
      expect.objectContaining({
        body: JSON.stringify({
          body: "Review body\n\n![Login badge](<https://assets.example/review/screenshots/login.png>)",
          event: "COMMENT",
        }),
        headers: expect.objectContaining({ authorization: "Bearer installation-token" }),
        method: "POST",
      }),
    )
  })
})
