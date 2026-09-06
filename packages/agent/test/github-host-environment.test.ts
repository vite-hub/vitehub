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

import { createGitHubHost } from "../src/server/github-host.ts";

it("isolates provider credentials and git directories across concurrent checkouts", async () => {
  let token = 0
  const host = createGitHubHost({
    credentials: () => ({ token: `token-${++token}`, rateLimitKey: "test" }),
    identity: { login: "worker" },
  });
  let release!: () => void;
  let arrived = 0;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const directories = await Promise.all(
    ["acme/one", "acme/two"].map((repository) =>
      host.withPullRequestCheckout(
        { repository, number: 1, headSha: "a".repeat(40) },
        async (checkout) => {
          if (++arrived === 2) release();
          await barrier;
          const env = await host.environment();
          expect(env.GH_TOKEN).toBe(checkout.token);
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
