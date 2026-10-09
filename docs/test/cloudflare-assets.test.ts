import { describe, expect, it } from "vitest";
import { shouldServePrerenderedAsset } from "../server/middleware/static-assets";

describe("Cloudflare prerendered page middleware", () => {
  const input = { method: "GET", userAgents: ["GPTBot"] };

  it("serves ordinary HTML requests from the asset binding", () => {
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/html,application/xhtml+xml" })).toBe(true);
    expect(shouldServePrerenderedAsset({ ...input, accept: "*/*" })).toBe(true);
  });

  it("leaves Markdown negotiation in Nitro", () => {
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/markdown" })).toBe(false);
    expect(shouldServePrerenderedAsset({ ...input, userAgent: "GPTBot" })).toBe(false);
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/markdown;q=0.1,text/html;q=1" })).toBe(true);
  });

  it("normalizes media types and quality parameter names", () => {
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/markdown;Q=0,*/*;q=1" })).toBe(true);
    expect(shouldServePrerenderedAsset({ ...input, accept: "text/markdown ; q=1,text/html;q=0" })).toBe(false);
  });
});
