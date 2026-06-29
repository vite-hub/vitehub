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

  it("publishes Workspace image paths before posting GitHub PR replies", async () => {
    const { github } = await import("../src/channels.ts")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" }).toString()
    const postedBodies: string[] = []
    const uploadedPaths: string[] = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith("/app/installations/456/access_tokens")) {
        return Response.json({ expires_at: new Date(Date.now() + 600_000).toISOString(), token: "installation-token" })
      }
      if (href.endsWith("/git/ref/heads/vitehub-agent-assets")) return Response.json({ message: "not found" }, { status: 404 })
      if (href.endsWith("/pulls/42")) return Response.json({ head: { sha: "head-sha" } })
      if (href.endsWith("/git/refs")) return Response.json({ ok: true }, { status: 201 })
      if (href.includes("/contents/")) {
        uploadedPaths.push(href)
        return Response.json({ content: { sha: "content-sha" } }, { status: 201 })
      }
      if (href.endsWith("/issues/42/comments")) {
        postedBodies.push(JSON.parse(String(init?.body)).body)
        return Response.json({ ok: true }, { status: 201 })
      }
      throw new Error(`Unexpected GitHub API call: ${href}`)
    })
    const channel = github({
      app: {
        apiBaseUrl: "https://api.github.test",
        appId: "2",
        fetch: fetcher as typeof fetch,
        installationId: 456,
        privateKey: privateKeyPem,
      },
    })
    const replyEffect = channel.effects?.reply
    if (typeof replyEffect !== "function") throw new Error("Missing GitHub reply effect.")

    await replyEffect({
      channel,
      effect: {
        kind: "reply",
        payload: { body: "Screenshot: screenshots/login.png" },
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
            installationId: 456,
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
      run: { runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
      workspace: {
        fs: {
          readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
          stat: vi.fn(async () => ({ mediaType: "image/png", path: "screenshots/login.png", type: "file" as const })),
        },
      },
    } as never)

    expect(uploadedPaths).toHaveLength(1)
    expect(uploadedPaths[0]).toContain("/contents/")
    expect(uploadedPaths[0]).toContain("vitehub-agent-assets")
    expect(postedBodies).toHaveLength(1)
    expect(postedBodies[0]).toContain("Screenshot: ![login.png](<https://github.com/vite-hub/vitehub/raw/vitehub-agent-assets/")
    expect(postedBodies[0]).not.toContain("Screenshot: screenshots/login.png")
  })
})
