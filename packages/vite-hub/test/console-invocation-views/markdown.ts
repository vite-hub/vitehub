import { Markdown } from "@vite-hub/ui";
import { mount } from "@vue/test-utils";
import { expect, vi } from "vitest";

/**
 * Loads the Markdown renderer before the tests of a file run. Call it in `beforeAll` of a file that mounts message or
 * event bodies.
 *
 * `Markdown` imports its renderer with the first Markdown that renders. Without this, a file whose tests end before
 * that import ends tears down its environment while the import still loads modules, and every Markdown that waits on
 * it reports an `EnvironmentTeardownError`.
 */
export async function loadMarkdown(): Promise<void> {
  const wrapper = mount(Markdown, { props: { value: "**Loaded**" } });
  await vi.waitFor(() => expect(wrapper.find("strong").text()).toBe("Loaded"), { timeout: 30_000 });
  wrapper.unmount();
}
