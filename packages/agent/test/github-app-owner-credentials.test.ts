import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createGitHubAppCredentials } from "../src/server/github-host.ts";

afterEach(() => vi.unstubAllGlobals());

it.each(["onmax", "OnMax"])("uses owner-scoped installation IDs configured as %s and discovers other owners once", async configuredOwner => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const discovered: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    discovered.push(String(input));
    return Response.json({ id: 303 });
  });
  const app = createGitHubAppCredentials({ appId: 1, privateKey, installationId: 101, owner: "vite-hub", installations: { [configuredOwner]: 202 } });
  const credentials = (repository: string) => app.credentials({ repository, signal: new AbortController().signal });
  expect((await credentials("vite-hub/vitehub")).installationId).toBe(101);
  expect((await credentials("onmax/vite-doctor")).installationId).toBe(202);
  expect((await credentials("nuxt-modules/better-auth")).installationId).toBe(303);
  expect((await credentials("nuxt-modules/another")).installationId).toBe(303);
  expect(discovered).toEqual(["https://api.github.com/repos/nuxt-modules/better-auth/installation"]);
});

it("isolates concurrent installation lookups from another caller's cancellation", async () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const requests: Array<{ signal?: AbortSignal | null; resolve: (response: Response) => void }> = [];
  vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({ signal: init?.signal, resolve });
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  const app = createGitHubAppCredentials({ appId: 1, privateKey });
  const controller = new AbortController();
  const first = app.credentials({ repository: "acme/first", signal: controller.signal });
  const firstObserved = first.then(() => undefined, error => error);
  await vi.waitFor(() => expect(requests.length).toBe(1));
  const second = app.credentials({ repository: "acme/second", signal: new AbortController().signal });
  const secondObserved = second.then(value => value, error => error);
  controller.abort(new DOMException("Status publication cancelled", "AbortError"));
  await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1));
  // Allow an independent lookup to reach the fake server before releasing it.
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const request of requests) request.resolve(Response.json({ id: 303 }));
  expect(await firstObserved).toBeInstanceOf(Error);
  expect(await secondObserved).toMatchObject({ installationId: 303 });
});
