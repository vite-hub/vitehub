import { afterEach, expect, it, vi } from "vitest";

const calls: string[][] = [];
const replies: Array<Error | string> = [];
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(() => {}, {
      [promisify.custom]: async (_command: string, args: string[]) => {
        calls.push(args);
        const reply = replies.shift() ?? "{}";
        if (reply instanceof Error) throw reply;
        return { stdout: reply, stderr: "" };
      },
    }),
  };
});

import { createGitHubHost } from "../src/server/github-host.ts";

const gatewayPage = () => Object.assign(new Error("Command failed: gh api repos/acme/app/git/ref/heads/main"), { stderr: "invalid character '<' looking for beginning of value" });
const host = (credentials = () => ({ token: "token", rateLimitKey: "acme" })) => createGitHubHost({ credentials, identity: { login: "worker" } });

afterEach(() => { calls.length = 0; replies.length = 0; vi.useRealTimers(); });

it("retries a REST read after a gateway page or a dropped connection", async () => {
  vi.useFakeTimers();
  replies.push(gatewayPage(), Object.assign(new Error("Command failed"), { stderr: "read: connection reset by peer" }), '{"ok":true}');
  const result = host().command(["api", "repos/acme/app/git/ref/heads/main"], { repository: "acme/app" });
  await vi.advanceTimersByTimeAsync(4_000);
  await expect(result).resolves.toMatchObject({ stdout: '{"ok":true}' });
  expect(calls).toHaveLength(3);
});

it("does not repeat a write, a rate limit or a client error", async () => {
  vi.useFakeTimers();
  for (const [args, failure] of [
    [["api", "-X", "PUT", "repos/acme/app/pulls/1/merge"], gatewayPage()],
    [["api", "repos/acme/app/issues/1/comments", "-f", "body=hi"], gatewayPage()],
    [["api", "repos/acme/app/pulls/1"], Object.assign(new Error("Command failed"), { stderr: "HTTP 404: Not Found" })],
    [["api", "repos/acme/app/pulls/1"], Object.assign(new Error("Command failed"), { stderr: "HTTP 403: API rate limit exceeded" })],
  ] as const) {
    calls.length = 0;
    replies.push(failure);
    const result = host().command([...args], { repository: "acme/app" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await result).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
  }
});

it("retries an explicit GET with query fields", async () => {
  vi.useFakeTimers();
  replies.push(gatewayPage(), '{"ok":true}');
  const result = host().command(["api", "-X", "GET", "repos/acme/app/issues", "-f", "state=open"], { repository: "acme/app" });
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(result).resolves.toMatchObject({ stdout: '{"ok":true}' });
  expect(calls).toHaveLength(2);
});

it("retries an explicit GET when query fields precede the method", async () => {
  vi.useFakeTimers();
  replies.push(gatewayPage(), '{"ok":true}');
  const result = host().command(["api", "-f", "state=open", "--method", "GET", "repos/acme/app/issues"], { repository: "acme/app" });
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(result).resolves.toMatchObject({ stdout: '{"ok":true}' });
  expect(calls).toHaveLength(2);
});

it("does not retry an explicit GET with a request body", async () => {
  vi.useFakeTimers();
  replies.push(gatewayPage());
  const result = host().command(["api", "-f", "state=open", "--method", "GET", "--input", "payload.json", "repos/acme/app/issues"], { repository: "acme/app" }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(await result).toBeInstanceOf(Error);
  expect(calls).toHaveLength(1);
});

it("retries an installation token that fails on a dropped connection", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const credentials = () => {
    if (++attempts === 1) throw new Error("Request to https://api.github.com/app/installations/1/access_tokens failed: fetch failed");
    return { token: "token", rateLimitKey: "acme" };
  };
  replies.push('{"ok":true}');
  const result = host(credentials).command(["api", "-X", "POST", "repos/acme/app/issues/1/comments"], { repository: "acme/app" });
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(result).resolves.toMatchObject({ stdout: '{"ok":true}' });
  expect(attempts).toBe(2);
});
