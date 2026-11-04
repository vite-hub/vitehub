// @vitest-environment happy-dom

import { flushPromises } from "@vue/test-utils";
import { expect, it, vi } from "vitest";
import { createCodeEditor } from "../src/workspace/codemirror.ts";

it("names the editor for the selected file after switching documents", async () => {
  const parent = document.createElement("div");
  const onChange = vi.fn();
  const editor = createCodeEditor({ doc: "first", onChange, parent, path: "server.txt", readonly: false });
  try {
    expect(parent.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Edit server.txt");
    editor.setDoc("second", "lib/greeting.txt");
    await flushPromises();
    expect(parent.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Edit lib/greeting.txt");
    expect(parent.querySelector(".cm-content")?.textContent).toBe("second");
    expect(onChange).not.toHaveBeenCalled();
  }
  finally {
    editor.destroy();
  }
});
