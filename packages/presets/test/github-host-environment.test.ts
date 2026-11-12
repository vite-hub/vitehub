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

import { createGitHubHost } from "../src/github/host.ts";

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
});
