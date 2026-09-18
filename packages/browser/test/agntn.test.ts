import { describe, expect, it, vi } from "vitest";

import { createBrowser } from "../src/client.ts";
import { agntnBrowser } from "../src/providers/agntn.ts";

function fixture() {
  return {
    createSession: vi.fn(async () => ({
      cdpUrl: "wss://provider.example/session?token=secret",
      id: "provider-session",
    })),
    name: () => "browserbase",
    releaseSession: vi.fn(async (_id: string) => {}),
  };
}

describe("agntnBrowser", () => {
  it("normalizes a missing provider into a ViteHub error", () => {
    expect(() => agntnBrowser(undefined as never)).toThrowError(
      expect.objectContaining({ code: "BROWSER_PROVIDER_ERROR" }),
    );
  });

  it("keeps provider credentials private through ViteHub's session API", async () => {
    const provider = fixture();
    const session = await createBrowser({ provider: agntnBrowser({ provider }) }).open();
    expect(session.inspect()).toMatchObject({ provider: "agntn:browserbase", state: "released" });
    expect(JSON.stringify(session.inspect())).not.toContain("secret");
    expect(session.id).not.toBe("provider-session");
    const control = await session.attach({
      name: "test",
      features: { attachExistingSession: true },
      attach: (connection) => ({ client: connection, release() {} }),
    });
    expect(control.client.endpoint).toBe("wss://provider.example/session?token=secret");
    await expect(session.close()).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" });
    await control.release();
    await expect(session.handoff({ audience: "run", mode: "live" })).rejects.toMatchObject({
      code: "BROWSER_LIVE_HANDOFF_UNSUPPORTED",
    });
    await session.close();
    await session.close();
    expect(provider.releaseSession).toHaveBeenCalledExactlyOnceWith("provider-session");
  });

  it("shares concurrent releases and retries a failed release", async () => {
    const provider = fixture();
    let rejectRelease!: (error: unknown) => void;
    const release = new Promise<void>((_, reject) => {
      rejectRelease = reject;
    });
    provider.releaseSession.mockImplementationOnce(() => release);
    const session = await agntnBrowser({ provider }).open();
    const first = session.close();
    const second = session.close();
    const result = Promise.allSettled([first, second]);
    rejectRelease(new Error("network failure"));
    expect((await result).map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(provider.releaseSession).toHaveBeenCalledOnce();
    await session.close();
    await session.close();
    expect(provider.releaseSession).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "not-a-url", "https://provider.example/session"])(
    "releases a session with an unusable CDP endpoint: %s",
    async (cdpUrl) => {
      const releaseSession = vi.fn(async () => {});
      const browser = agntnBrowser({
        provider: {
          createSession: async () => ({ id: "session", cdpUrl }),
          name: () => "test",
          releaseSession,
        },
      });
      await expect(browser.open()).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" });
      expect(releaseSession).toHaveBeenCalledExactlyOnceWith("session");
    },
  );

  it("retains setup and cleanup failures without leaking them in the public message", async () => {
    const provider = fixture();
    const setupError = new Error("secret endpoint");
    const cleanupError = new Error("secret token");
    provider.releaseSession.mockRejectedValueOnce(cleanupError);
    const browser = agntnBrowser({
      provider,
      connection() {
        throw setupError;
      },
    });
    await expect(browser.open()).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
      cause: { errors: [setupError, cleanupError] },
      message:
        "[vitehub:browser] agntn:browserbase could not resolve a CDP connection and release the session.",
    });
  });

  it("requires explicit Cloudflare connection authentication", async () => {
    const provider = { ...fixture(), name: () => "cloudflare" };
    await expect(agntnBrowser({ provider }).open()).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
    });
    expect(provider.releaseSession).toHaveBeenCalledOnce();
    const connection = {
      endpoint: "wss://provider.example/session",
      kind: "cdp" as const,
      headers: { Authorization: "Bearer secret" },
    };
    const session = await agntnBrowser({ provider, connection: () => connection }).open();
    expect(session.connection).toEqual(connection);
    await session.close();
  });

  it("requires an explicit idle timeout mapping before allocating a session", async () => {
    const provider = fixture();
    await expect(agntnBrowser({ provider }).open({ idleTimeoutMs: 1_000 })).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
    });
    expect(provider.createSession).not.toHaveBeenCalled();
    const session = await agntnBrowser({
      provider,
      sessionOptions: ({ idleTimeoutMs }) => ({ extra: { idleTimeout: idleTimeoutMs } }),
    }).open({ idleTimeoutMs: 1_000 });
    expect(provider.createSession).toHaveBeenCalledWith({ extra: { idleTimeout: 1_000 } });
    await session.close();
  });
});
