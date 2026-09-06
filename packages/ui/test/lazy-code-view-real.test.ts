// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { AgentPatchDiff } from "../src/components/agent-code-view.ts";

describe("lazy Pierre renderer", () => {
  it("loads the real patch renderer through the public component", async () => {
    const wrapper = mount(AgentPatchDiff, {
      props: {
        patch: "--- a/ready.ts\n+++ b/ready.ts\n@@ -1 +1 @@\n-false\n+true\n",
      },
    });

    await vi.waitFor(() => {
      expect(wrapper.find("diffs-container").exists()).toBe(true);
    });
  });
});
