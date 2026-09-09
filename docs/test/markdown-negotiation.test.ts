import { describe, expect, it } from "vitest";
import { acceptsAgentFriendlyError } from "../server/utils/markdown-negotiation";

describe("Markdown content negotiation", () => {
  it("recognizes case-insensitive quality parameters", () => {
    expect(acceptsAgentFriendlyError("text/markdown;Q=0")).toBe(false);
  });
});
