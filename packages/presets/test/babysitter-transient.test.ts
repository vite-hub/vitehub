import { describe, expect, it } from "vitest";
import { ForgeApiError } from "@vite-hub/forge";
import { isTransientNetworkError, retryTransient } from "../src/babysitter/transient.ts";

const named = (name: string, message: string, cause?: unknown) => Object.assign(new Error(message, { cause }), { name });

describe("transient network errors", () => {
  it("recognizes dropped connections, timeouts and gateway errors, also as a cause", () => {
    expect(isTransientNetworkError(named("ForgeNetworkError", "Request failed: fetch failed"))).toBe(true);
    expect(isTransientNetworkError(named("ForgeTimeoutError", "Request timed out after 30000ms"))).toBe(true);
    expect(isTransientNetworkError(new Error("Installation token failed", { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) }))).toBe(true);
    expect(isTransientNetworkError(new ForgeApiError("Forge responded with 503", 503, "", { forge: "github" } as never))).toBe(true);
  });

  it("leaves other failures to the pass", () => {
    expect(isTransientNetworkError(new ForgeApiError("Forge responded with 500", 500, "", { forge: "github" } as never))).toBe(false);
    expect(isTransientNetworkError(new DOMException("The operation timed out.", "TimeoutError"))).toBe(false);
    expect(isTransientNetworkError(new Error("Typecheck failed"))).toBe(false);
  });

  it("retries a read after a transient failure only", async () => {
    let calls = 0;
    await expect(retryTransient(async () => {
      if (calls++ === 0) throw named("ForgeNetworkError", "fetch failed");
      return "read";
    })).resolves.toBe("read");
    expect(calls).toBe(2);
    calls = 0;
    await expect(retryTransient(async () => { calls++; throw new Error("Not Found"); })).rejects.toThrow("Not Found");
    expect(calls).toBe(1);
  });
});
