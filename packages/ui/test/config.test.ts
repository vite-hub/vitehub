import { describe, expect, it } from "vitest";
import { resolveViteHubUIDefaults } from "../src/config.ts";

describe("ViteHub UI defaults", () => {
  it("merges nested defaults without dropping stable values", () => {
    expect(
      resolveViteHubUIDefaults({ defaults: { messageScroller: { edgeThreshold: 16 } } }),
    ).toEqual({
      markdown: { class: "vh-typeset vh-typeset-chat" },
      messageScroller: { edgeThreshold: 16, previousItemPeek: 64 },
    });
  });
});
