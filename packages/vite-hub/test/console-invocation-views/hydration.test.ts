// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSSRApp, h, nextTick, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { AgentInvocation } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { AgentInvocationList } from "../../src/console/runtime/components/invocation/agent-invocation-list.ts";
import { event, invocation, message, tool } from "./fixtures.ts";

async function serverRender(component: Component): Promise<HTMLElement> {
  const container = document.createElement("div");
  container.innerHTML = await renderToString(createSSRApp(component));
  document.body.append(container);
  return container;
}

/** Hydrates server HTML and returns the hydration warnings. */
async function hydrate(container: HTMLElement, component: Component) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const app = createSSRApp(component);
  app.mount(container);
  await nextTick();
  return { warnings: [...warn.mock.calls, ...error.mock.calls].flat().join(" "), unmount: () => { app.unmount(); container.remove(); } };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Console invocation views in the browser after server rendering", () => {
  it("hydrates message timestamps before applying browser locale formatting", async () => {
    const at = "2026-09-05T00:30:00.000Z";
    const component = { render: () => h(AgentInvocation, { invocation: invocation(
      [event("agent.input", { "input.messages": [{ id: "prompt", role: "user", parts: [{ type: "text", text: "Check this" }] }] }, { timestamp: at })],
      { createdAt: at, updatedAt: at },
    ) }) };
    const time = (container: HTMLElement) => container.querySelector(".vh-invocation-message__meta time")?.textContent;
    const container = await serverRender(component);
    expect(time(container)).toBe(at);

    const DateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locale, options) {
      return new DateTimeFormat(locale ?? "de-DE", { ...options, timeZone: "America/Los_Angeles" });
    });
    const { warnings, unmount } = await hydrate(container, component);
    expect(time(container)).not.toBe(at);
    expect(warnings).not.toMatch(/hydration/i);
    unmount();
  });

  it.each(["pending", "running"] as const)("hydrates %s work before starting its live elapsed timer", async (status) => {
    const at = "2026-09-05T00:00:00.000Z";
    const component = { render: () => h(AgentInvocation, { invocation: invocation([
      message("user", "Run it.", { "message.id": "user" }, { timestamp: at }),
      tool("start", "shell", "shell", { "tool.input": { command: "pnpm test" } }, { timestamp: at }),
    ], { createdAt: at, startedAt: at, status, updatedAt: at }) }) };
    const elapsed = (container: HTMLElement) => container.querySelector(".vh-invocation-work__elapsed")?.textContent;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:01.000Z"));
    const container = await serverRender(component);
    expect(elapsed(container)).toBeUndefined();

    vi.setSystemTime(new Date("2026-09-05T00:00:02.000Z"));
    const { warnings, unmount } = await hydrate(container, component);
    expect(elapsed(container)).toBe("0:02");
    expect(warnings).not.toMatch(/hydration/i);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(elapsed(container)).toBe("0:03");
    unmount();
  });

  it("hydrates complete invocation lists without dropping rows", async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({ id: `inv-${index}`, status: "completed" as const, title: `Invocation ${index}` }));
    const component = { render: () => h(AgentInvocationList, { items }) };
    const container = await serverRender(component);
    const { warnings, unmount } = await hydrate(container, component);
    expect(warnings).not.toContain("Hydration");
    expect(container.querySelectorAll("li")).toHaveLength(40);
    unmount();
  });
});
