import { describe, expect, it, vi } from "vitest";

import { agntnBrowser } from "../src/providers/agntn.ts";

describe("agntnBrowser", () => {
  it("adapts an Agntn session to ViteHub's CDP provider contract", async () => {
    const createSession = vi.fn(async () => ({
      cdpUrl: "wss://provider.example/session",
      id: "provider-session",
      provider: "playwright",
    }));
    const releaseSession = vi.fn(async () => {});
    const browser = agntnBrowser({
      provider: {
        createSession,
        name: () => "playwright",
        releaseSession,
      },
      sessionOptions: { headless: true },
    });

    expect(browser.name).toBe("agntn:playwright");
    expect(browser.features.liveHandoff).toBe(false);

    const session = await browser.open({ idleTimeoutMs: 10_000 });
    expect(createSession).toHaveBeenCalledWith({ headless: true });
    expect(session).toMatchObject({
      connection: { endpoint: "wss://provider.example/session", kind: "cdp" },
      id: "provider-session",
    });

    await session.close();
    await session.close();
    expect(releaseSession).toHaveBeenCalledOnce();
  });

  it("releases a provider session when the CDP endpoint cannot be resolved", async () => {
    const releaseSession = vi.fn(async () => {});
    const browser = agntnBrowser({
      provider: {
        createSession: async () => ({ id: "provider-session", provider: "anchor" }),
        name: () => "anchor",
        releaseSession,
      },
    });

    await expect(browser.open()).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
      details: { operation: "resolve a CDP endpoint" },
    });
    expect(releaseSession).toHaveBeenCalledWith("provider-session");
  });

  it("allows provider-specific connection authentication", async () => {
    const browser = agntnBrowser({
      connection: () => ({
        endpoint: "wss://provider.example/session",
        headers: { Authorization: "Bearer secret" },
        kind: "cdp",
      }),
      provider: {
        createSession: async () => ({ id: "provider-session", provider: "kernel" }),
        name: () => "kernel",
        releaseSession: async () => {},
      },
    });

    const session = await browser.open();
    expect(session.connection).toEqual({
      endpoint: "wss://provider.example/session",
      headers: { Authorization: "Bearer secret" },
      kind: "cdp",
    });
    await session.close();
  });
});
