import { expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(() => {}, {
      [promisify.custom]: async (_command: string, args: string[]) => ({
        stdout: args.includes("rev-parse") ? "a".repeat(40) : "",
        stderr: "",
      }),
    }),
  };
});

vi.mock("#vitehub/agent/registry", () => ({ default: {}, loadAgentHost: async () => {} }));

import { publishAgentActivity } from "@vite-hub/agent";
import { createGitHubAppCredentials, createGitHubHost } from "../src/github/host.ts";

it("isolates provider credentials and git directories across concurrent checkouts", async () => {
  let token = 0
  const host = createGitHubHost({
    credentials: ({ repository }) => ({ token: `${repository ?? "default"}:${++token}` }),
    identity: { login: "worker" },
  });
  let release!: () => void;
  let arrived = 0;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const directories = await Promise.all(
    ["acme/one", "other/two"].map((repository) =>
      host.withPullRequestCheckout(
        { repository, number: 1, headSha: "a".repeat(40) },
        async (checkout) => {
          if (++arrived === 2) release();
          await barrier;
          const env = await host.environment();
          expect(env.GH_TOKEN).toBe(checkout.token);
          expect(env.GH_TOKEN).toMatch(new RegExp(`^${repository}:`));
          expect(env.GIT_DIR).toBe(`${checkout.path}/.git`);
          expect(env.GIT_WORK_TREE).toBe(".");
          return env.GIT_DIR;
        },
      ),
    ),
  );
  expect(directories[0]).not.toBe(directories[1]);
  expect((await host.environment()).GIT_DIR).toBeUndefined();
});

it("gives the channel forge access the host commit identity", async () => {
  const identity = { login: "quiver-bot[bot]", email: "294442778+quiver-bot[bot]@users.noreply.github.com" }
  const host = createGitHubHost({ credentials: () => ({ token: "installation-token" }), identity })
  const access: unknown = Reflect.get(host.channel(), Symbol.for("vitehub.agent.forgeAccess"))
  if (typeof access !== "function") throw new Error("The host channel has no forge access.")
  await expect(access({}, { repository: "acme/app" })).resolves.toEqual({ token: "installation-token", identity });
})

it("mints a new App token when the cached one expires within the requested lifetime", async () => {
  const { generateKeyPairSync } = await import("node:crypto")
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  const now = Date.now()
  const clock = vi.spyOn(Date, "now").mockReturnValue(now)
  let minted = 0
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    if (path === "/app") return Response.json({ id: 7, slug: "token-lifetime-bot" })
    if (path.startsWith("/users/")) return Response.json({ id: 70 })
    return Response.json({ token: `app-token-${++minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
  })
  try {
    const host = createGitHubHost({ credentials: () => ({ appId: 7, installationId: 9, owner: "acme", privateKey }) })
    const access: unknown = Reflect.get(host.channel(), Symbol.for("vitehub.agent.forgeAccess"))
    if (typeof access !== "function") throw new Error("The host channel has no forge access.")
    expect((await access({}, { repository: "acme/app" })).token).toBe("app-token-1")
    clock.mockReturnValue(now + 50 * 60_000)
    expect((await access({}, { repository: "acme/app" })).token).toBe("app-token-1")
    expect((await access({}, { repository: "acme/app", minLifetime: 55 * 60_000 })).token).toBe("app-token-2")
  }
  finally {
    clock.mockRestore()
    vi.unstubAllGlobals()
  }
});

it("commits and comments as the bot of its GitHub App without a configured identity", async () => {
  const { generateKeyPairSync } = await import("node:crypto")
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  const requests: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    requests.push(path)
    if (path === "/app") return Response.json({ id: 294442778, slug: "quiver-bot" })
    if (path === "/users/quiver-bot%5Bbot%5D") return Response.json({ id: 294442779, login: "quiver-bot[bot]" })
    if (path === "/app/installations/9/access_tokens") return Response.json({ token: "app-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    if (path === "/user") {
      if (new Headers(init?.headers).get("authorization") === "Bearer fallback-token") return Response.json({ login: "fallback-user" })
      return Response.json({ message: "Requires authentication" }, { status: 401 })
    }
    if (path === "/repos/quiverdk/portal/issues/43/comments" && init?.method === "GET") {
      return Response.json([
        { id: 7, body: "<!-- vitehub-agent-activity:e30 -->", performed_via_github_app: { id: 294442778 } },
        { id: 8, body: "<!-- vitehub-agent-activity:e30 -->", user: { login: "fallback-user" } },
      ])
    }
    if (path === "/repos/quiverdk/portal/issues/comments/8" && init?.method === "PATCH") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fallback-token")
      return Response.json({ id: 8 })
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer app-token")
    if (path === "/repos/quiverdk/portal/issues/42/comments" && init?.method === "GET") {
      return Response.json([{ id: 7, body: "<!-- vitehub-agent-activity:e30 -->", performed_via_github_app: { id: 294442778 } }])
    }
    if (path === "/repos/quiverdk/portal/issues/comments/7" && init?.method === "PATCH") return Response.json({ id: 7 })
    throw new Error(`Unexpected GitHub API call: ${init?.method} ${path}`)
  })
  vi.stubGlobal("fetch", fetcher)
  try {
    const { credentials } = createGitHubAppCredentials({ appId: 294442778, installationId: 9, owner: "quiverdk", privateKey })
    const host = createGitHubHost({ credentials })
    const bot = { login: "quiver-bot[bot]", email: "294442779+quiver-bot[bot]@users.noreply.github.com" }
    const channel = host.channel({ activity: true })

    const { env } = await host.access({ repository: "quiverdk/portal" })
    expect(env).toMatchObject({ GIT_AUTHOR_NAME: bot.login, GIT_AUTHOR_EMAIL: bot.email, GIT_COMMITTER_NAME: bot.login, GIT_COMMITTER_EMAIL: bot.email })
    expect(host.identity()).toBe(bot.login)
    expect(host.appId?.()).toBe(294442778)

    await publishAgentActivity({ name: "worker", channels: { github: channel } }, {
      channelId: "github", target: { repository: "quiverdk/portal", issue: 42 },
      activity: { runId: "app-run", status: "completed", links: [], tasks: [] },
    })
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/quiverdk/portal/issues/comments/7", expect.objectContaining({ method: "PATCH" }))
    const access: unknown = Reflect.get(channel, Symbol.for("vitehub.agent.forgeAccess"))
    if (typeof access !== "function") throw new Error("The host channel has no forge access.")
    await expect(access({}, { repository: "quiverdk/portal" })).resolves.toEqual({ token: "app-token", identity: bot })
    expect(requests.filter(path => path === "/app")).toHaveLength(1)

    const fallbackChannel = createGitHubHost({
      credentials: ({ repository }) => repository ? { token: "fallback-token" } : { appId: 294442778, installationId: 9, owner: "quiverdk", privateKey },
    }).channel({ activity: true })
    await publishAgentActivity({ name: "worker", channels: { github: fallbackChannel } }, {
      channelId: "github", target: { repository: "quiverdk/portal", issue: 43 },
      activity: { runId: "fallback-run", status: "completed", links: [], tasks: [] },
    })
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/quiverdk/portal/issues/comments/8", expect.objectContaining({ method: "PATCH" }))
  }
  finally {
    vi.unstubAllGlobals()
  }
})
