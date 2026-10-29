import { describe, expect, it } from "vitest";
import { getCanonicalRedirect } from "../server/middleware/canonical-url";

function redirect(url: string, method = "GET") {
  return getCanonicalRedirect({ method, url: new URL(url) });
}

describe("canonical page URLs", () => {
  it("moves www pages to the apex host and keeps the path and query", () => {
    expect(redirect("https://www.vitehub.dev/")).toBe("https://vitehub.dev/");
    expect(redirect("https://www.vitehub.dev/docs/queue?lane=agents")).toBe("https://vitehub.dev/docs/queue?lane=agents");
    expect(redirect("http://www.vitehub.dev/docs/kv/")).toBe("https://vitehub.dev/docs/kv");
  });

  it("removes a trailing slash on the same host", () => {
    expect(redirect("https://vitehub.dev/docs/queue/")).toBe("/docs/queue");
    expect(redirect("https://vitehub.dev/docs/queue//?a=1")).toBe("/docs/queue?a=1");
  });

  it("leaves canonical URLs and other methods alone", () => {
    expect(redirect("https://vitehub.dev/")).toBeUndefined();
    expect(redirect("https://vitehub.dev/docs/queue")).toBeUndefined();
    expect(redirect("https://vitehub.dev/mcp/", "POST")).toBeUndefined();
  });
});
