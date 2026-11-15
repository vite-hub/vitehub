// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import type { WebContainerStep } from "@vite-hub/web-container";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, nextTick } from "vue";
import { BrowserSupportNotice, detectUnsupportedBrowser } from "../src/workspace/browser-support-notice.ts";
import { bootChecklist, formatElapsed, WorkspaceBootStatus } from "../src/workspace.ts";
import { WorkspacePreview, workspacePreviewScript } from "../src/workspace/workspace-preview.ts";
import { WorkspaceShell } from "../src/workspace/workspace-shell.ts";
import { WorkspaceTerminal } from "../src/workspace/workspace-terminal.ts";

const terminal = vi.hoisted(() => ({ reset: vi.fn(), write: vi.fn(), options: {} as { theme?: { background?: string } } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: { theme?: { background?: string } }) {
      terminal.options = options;
    }
    get options() { return terminal.options; }
    reset = terminal.reset;
    write = terminal.write;
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WorkspaceTerminal", () => {
  it("appends ordinary arrays and resets when they are replaced or cleared", async () => {
    vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); disconnect = vi.fn(); });
    terminal.reset.mockClear();
    terminal.write.mockClear();
    const wrapper = mount(WorkspaceTerminal, { props: { output: ["first"] } });
    await flushPromises();
    expect(terminal.write.mock.calls).toEqual([["first"]]);
    terminal.write.mockClear();
    await wrapper.setProps({ output: ["first", "second"] });
    expect(terminal.write.mock.calls).toEqual([["second"]]);
    expect(terminal.reset).not.toHaveBeenCalled();
    terminal.write.mockClear();
    await wrapper.setProps({ output: ["replacement"] });
    expect(terminal.write.mock.calls).toEqual([["replacement"]]);
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ output: [] });
    expect(terminal.reset).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("takes the new colors when the page changes color mode", async () => {
    vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); disconnect = vi.fn(); });
    const wrapper = mount(WorkspaceTerminal, { attachTo: document.body });
    const host = wrapper.element as HTMLElement;
    host.style.setProperty("--vh-ws-terminal-bg", "#fafafa");
    try {
      await flushPromises();
      expect(terminal.options.theme?.background).toBe("#fafafa");
      host.style.setProperty("--vh-ws-terminal-bg", "#0a0a0a");
      document.documentElement.classList.add("dark");
      await flushPromises();
      expect(terminal.options.theme?.background).toBe("#0a0a0a");
    }
    finally {
      wrapper.unmount();
      document.documentElement.classList.remove("dark");
    }
  });
});

describe("WorkspaceBootStatus", () => {
  const steps = (...list: WebContainerStep[]) => list;

  it("maps the steps to five rows and formats times", () => {
    const rows = bootChecklist(steps(
      { ms: 2, stage: "checking", startedAt: 0 },
      { ms: 1500, stage: "booting", startedAt: 2 },
      { ms: 40, stage: "mounting", startedAt: 1502 },
      { stage: "installing", startedAt: 1542 },
    ), "installing", 31_542);
    expect(rows.map(row => [row.label, row.state])).toEqual([
      ["Check browser support", "done"],
      ["Start WebContainer", "done"],
      ["Load project files", "done"],
      ["Install dependencies", "running"],
      ["Start dev server", "pending"],
    ]);
    expect(rows[3]?.ms).toBe(30_000);
    expect(formatElapsed(1234)).toBe("1.2 s");
    expect(formatElapsed(30_000)).toBe("30 s");
    expect(formatElapsed(95_000)).toBe("1 min 35 s");
  });

  it("marks a skipped install and the failed stage", () => {
    const rows = bootChecklist(steps(
      { ms: 1, stage: "checking", startedAt: 0 },
      { ms: 1, stage: "booting", startedAt: 1 },
      { ms: 9, stage: "starting", startedAt: 2 },
      { ms: 0, stage: "error", startedAt: 11 },
    ), "error", 20);
    expect(rows.map(row => row.state)).toEqual(["done", "done", "skipped", "skipped", "failed"]);
  });

  it("shows the slow install hint after 20 seconds, with no progress bar", async () => {
    vi.useFakeTimers();
    const startedAt = performance.now();
    const wrapper = mount(WorkspaceBootStatus, {
      props: { status: "installing", steps: [{ stage: "installing", startedAt }] },
    });
    expect(wrapper.text()).not.toContain("First install downloads packages");
    await vi.advanceTimersByTimeAsync(21_000);
    expect(wrapper.text()).toContain("First install downloads packages. Later steps reuse them.");
    expect(wrapper.find("progress, [role='progressbar']").exists()).toBe(false);
    expect(wrapper.get("[data-stage='installing']").attributes("data-state")).toBe("running");
    wrapper.unmount();
  });

  it("offers the recovery action for each failure", async () => {
    const wrapper = mount(WorkspaceBootStatus, {
      props: { failure: { error: new Error("x"), exitCode: 1, kind: "install" }, status: "error", steps: [] },
    });
    expect(wrapper.text()).toContain("Install failed");
    expect(wrapper.text()).toContain("npm install exited with code 1.");
    await wrapper.get("button.vh-ws-button--primary").trigger("click");
    expect(wrapper.emitted("retry-install")).toHaveLength(1);
    await wrapper.findAll("button").find(button => button.text() === "Show output")?.trigger("click");
    expect(wrapper.emitted("show-output")).toHaveLength(1);

    await wrapper.setProps({ failure: { error: new Error("x"), exitCode: 1, kind: "server" } });
    expect(wrapper.get("button.vh-ws-button--primary").text()).toBe("Restart server");
    await wrapper.setProps({ failure: { error: new Error("Network error"), kind: "boot" } });
    expect(wrapper.text()).toContain("The workspace did not start");
    expect(wrapper.get("button.vh-ws-button--primary").text()).toBe("Try again");
    await wrapper.setProps({ online: false });
    expect(wrapper.text()).toContain("You are offline.");
    expect(wrapper.text()).toContain("Your edits are kept.");
    expect(wrapper.text()).not.toContain("—");
  });
});

describe("BrowserSupportNotice", () => {
  it("renders nothing until the check says the browser is not supported", async () => {
    const wrapper = mount(BrowserSupportNotice, { props: { supported: undefined } });
    expect(wrapper.find("aside").exists()).toBe(false);
    await wrapper.setProps({ supported: true });
    expect(wrapper.find("aside").exists()).toBe(false);
    await wrapper.setProps({ browser: "safari", supported: false });
    expect(wrapper.get("aside").text()).toContain("The live workspace does not run in Safari");
    expect(wrapper.text()).toContain("open this page in Chrome, Edge, or Firefox on a desktop.");

    const why = wrapper.findAll("button").find(button => button.text() === "Why?");
    expect(why?.attributes("aria-expanded")).toBe("false");
    await why?.trigger("click");
    expect(wrapper.text()).toContain("Safari does not support the browser isolation that WebContainers need to run Node.js in a tab.");

    await wrapper.setProps({ browser: "unknown" });
    expect(wrapper.text()).toContain("does not run in this browser");

    await wrapper.setProps({ description: "Download the files to run them on your machine." });
    expect(wrapper.text()).toContain("Download the files to run them on your machine.");
    expect(wrapper.text()).not.toContain("This tutorial still works as text.");
  });

  it("explains missing page isolation without recommending another browser", async () => {
    const wrapper = mount(BrowserSupportNotice, { props: { supported: false, reason: "The page is not cross-origin isolated." } });
    await nextTick();
    expect(wrapper.text()).toContain("This page needs workspace setup");
    expect(wrapper.text()).not.toContain("open this page in Chrome");
    wrapper.unmount();
  });

  it("renders nothing on the server, so a supported browser never sees it flash", async () => {
    const { renderToString } = await import("@vue/server-renderer");
    const { createSSRApp } = await import("vue");
    expect(await renderToString(createSSRApp(BrowserSupportNotice, { supported: false }))).toBe("<!---->");
  });

  it("detects Safari and iOS browsers", () => {
    expect(detectUnsupportedBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("safari");
    expect(detectUnsupportedBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1")).toBe("safari");
    expect(detectUnsupportedBrowser("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("unknown");
  });
});

describe("WorkspaceShell", () => {
  it("shows one tab panel, makes the others inert, and remembers split sizes", async () => {
    const wrapper = mount(WorkspaceShell, {
      attachTo: document.body,
      props: { layout: "tutorial" },
      slots: {
        connect: () => h("p", "connect"),
        editor: () => h("p", "editor"),
        files: () => h("p", "files"),
        preview: () => h("p", "preview"),
        terminal: () => h("p", "terminal"),
      },
    });
    // The strip is Nuxt UI's UTabs, which loads on first render. It selects a tab on mouse down, as reka-ui does.
    await vi.waitFor(() => expect(wrapper.findAll("[role='tab']")).toHaveLength(3), { timeout: 5_000 });
    const tabs = wrapper.findAll("[role='tab']");
    expect(tabs.map(tab => tab.text())).toEqual(["Preview", "Terminal", "Connect"]);
    expect(wrapper.get("[data-tab='terminal']").attributes()).toHaveProperty("inert");
    expect(wrapper.get("[data-tab='preview']").attributes()).not.toHaveProperty("inert");

    await tabs[1]?.trigger("mousedown", { button: 0 });
    expect(wrapper.emitted("update:tab")).toEqual([["terminal"]]);
    expect(wrapper.get("[data-tab='preview']").attributes()).toHaveProperty("inert");

    const separator = wrapper.get("[data-split='main']");
    expect(separator.attributes("aria-valuenow")).toBe("55");
    await separator.trigger("keydown", { key: "ArrowDown" });
    expect(JSON.parse(localStorage.getItem("vitehub:workspace:tutorial") ?? "{}")).toMatchObject({ main: 60 });
    wrapper.unmount();

    const again = mount(WorkspaceShell, { props: { layout: "tutorial" }, slots: { editor: () => h("p", "editor") } });
    await nextTick();
    expect(again.get("[data-split='main']").attributes("aria-valuenow")).toBe("60");
  });

  it("puts the panels under the editor and the preview at the side in a playground", async () => {
    const wrapper = mount(WorkspaceShell, {
      props: { layout: "playground", storageKey: false },
      slots: { editor: () => h("p", "editor"), preview: () => h("p", "preview"), terminal: () => h("p", "terminal") },
    });
    await vi.waitFor(() => expect(wrapper.findAll("[role='tab']").map(tab => tab.text())).toEqual(["Terminal"]), { timeout: 5_000 });
    expect(wrapper.get(".vh-ws-pane--side").text()).toBe("preview");
  });

  it("shows the tabs of the page, in order, with their badges", async () => {
    const wrapper = mount(WorkspaceShell, {
      props: { layout: "tutorial", storageKey: false, tabs: [{ label: "Console", value: "terminal" }, { badge: 2, label: "Messages", value: "messages" }] },
      slots: { editor: () => h("p", "editor"), messages: () => h("p", "messages"), terminal: () => h("p", "terminal") },
    });
    await vi.waitFor(() => expect(wrapper.findAll("[role='tab']").map(tab => tab.text())).toEqual(["Console", "Messages2"]), { timeout: 5_000 });
    expect(wrapper.get("[data-tab='messages']").text()).toBe("messages");
  });
});

describe("WorkspacePreview", () => {
  it("shows an empty state, then the preview in an iframe with a path bar", async () => {
    const wrapper = mount(WorkspacePreview);
    expect(wrapper.text()).toContain("No preview yet");
    expect(wrapper.get("[aria-label='Reload preview']").attributes()).toHaveProperty("disabled");

    await wrapper.setProps({ path: "/api/hello", url: "https://abc.webcontainer.io" });
    const frame = wrapper.get("iframe");
    expect(frame.attributes("src")).toBe("https://abc.webcontainer.io/api/hello");
    expect(wrapper.get("a[aria-label='Open preview in a new tab']").attributes()).toMatchObject({ href: "https://abc.webcontainer.io/api/hello", target: "_blank" });

    // The path field is Nuxt UI's UInput, which loads on first render.
    await vi.waitFor(() => expect(wrapper.find("input").exists()).toBe(true), { timeout: 5_000 });
    await wrapper.get("input").setValue("todos");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("update:path")).toEqual([["/todos"]]);

    await wrapper.get("[aria-label='Reload preview']").trigger("click");
    expect(wrapper.get("iframe").element).not.toBe(frame.element);
  });

  it("follows the page address and goes Back and Forward through the preview script", async () => {
    const wrapper = mount(WorkspacePreview, { props: { path: "/", url: "https://abc.webcontainer.io" }, attachTo: document.body });
    expect(wrapper.get("[aria-label='Go back']").attributes()).toHaveProperty("disabled");
    const frame = wrapper.get("iframe").element as HTMLIFrameElement;
    // happy-dom loads no frames. The preview origin wraps the app in a frame of its own, so the app is a frame inside.
    const outer = { parent: window };
    Object.defineProperty(frame, "contentWindow", { value: outer });
    const inner = { parent: outer } as unknown as Window;
    const { port1: app, port2 } = new MessageChannel();
    const sent: unknown[] = [];
    app.onmessage = ({ data }) => { sent.push(data); };
    // A message from a window outside the frame is ignored.
    window.dispatchEvent(new MessageEvent("message", { data: { type: "vitehub:preview" }, source: window, ports: [new MessageChannel().port2] }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "vitehub:preview" }, source: inner, ports: [port2] }));
    app.postMessage({ type: "location", path: "/about?tab=2", back: true, forward: false });
    await vi.waitFor(() => expect(wrapper.get("a[aria-label='Open preview in a new tab']").attributes("href")).toBe("https://abc.webcontainer.io/about?tab=2"));
    await vi.waitFor(() => expect(wrapper.find("input").exists()).toBe(true), { timeout: 5_000 });
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("/about?tab=2");
    expect(wrapper.get("[aria-label='Go forward']").attributes()).toHaveProperty("disabled");

    await wrapper.get("[aria-label='Go back']").trigger("click");
    await wrapper.get("[aria-label='Reload preview']").trigger("click");
    await vi.waitFor(() => expect(sent).toEqual(["back", "reload"]));
    // The script reloads the page where it is, so the frame stays.
    expect(wrapper.get("iframe").element).toBe(frame);
    app.close();
    wrapper.unmount();
  });

  it("shows the page at a device width and keeps the choice", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const wrapper = mount(WorkspacePreview, { props: { url: "https://abc.webcontainer.io" } });
    const frame = wrapper.get("iframe").element;
    expect(wrapper.get("[aria-label='Desktop']").attributes("aria-pressed")).toBe("true");
    expect(wrapper.find(".vh-device-frame[data-on]").exists()).toBe(false);

    await wrapper.get("[aria-label='Phone']").trigger("click");
    expect(wrapper.get(".vh-device-frame__page").attributes("style")).toContain("width: 390px");
    expect(wrapper.find("[role='toolbar']").exists()).toBe(false);
    expect(wrapper.get("iframe").element).toBe(frame);
    expect(wrapper.emitted("update:device")).toEqual([["phone"]]);
    expect(localStorage.getItem("vitehub:workspace-preview:device")).toBe("phone");
    wrapper.unmount();

    const next = mount(WorkspacePreview, { props: { url: "https://abc.webcontainer.io" } });
    expect(next.get("[aria-label='Phone']").attributes("aria-pressed")).toBe("true");
    await next.setProps({ device: "tablet" });
    expect(next.get(".vh-device-frame__page").attributes("style")).toContain("width: 768px");
    next.unmount();
  });

  it.each([false, true])("keeps navigation on the outer app when the child announces first: %s", async (childFirst) => {
    const wrapper = mount(WorkspacePreview, { props: { url: "https://abc.webcontainer.io" }, attachTo: document.body });
    const frame = wrapper.get("iframe").element as HTMLIFrameElement;
    const shell = { parent: window };
    const appWindow = { parent: shell } as unknown as Window;
    const childWindow = { parent: appWindow } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", { value: shell });
    const app = new MessageChannel();
    const child = new MessageChannel();
    const appCommands: unknown[] = [];
    const childCommands: unknown[] = [];
    app.port1.onmessage = ({ data }) => appCommands.push(data);
    child.port1.onmessage = ({ data }) => childCommands.push(data);
    const announce = (source: Window, channel: MessageChannel, path: string) => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "vitehub:preview" }, source, ports: [channel.port2] }));
      channel.port1.postMessage({ type: "location", path, back: true, forward: true });
    };
    if (childFirst) announce(childWindow, child, "/embedded");
    announce(appWindow, app, "/app");
    await vi.waitFor(() => expect(wrapper.get("a[aria-label='Open preview in a new tab']").attributes("href")).toBe("https://abc.webcontainer.io/app"));
    if (!childFirst) announce(childWindow, child, "/embedded");
    await wrapper.get("[aria-label='Reload preview']").trigger("click");
    await wrapper.get("[aria-label='Go back']").trigger("click");
    await wrapper.get("[aria-label='Go forward']").trigger("click");
    await vi.waitFor(() => expect(appCommands).toEqual(["reload", "back", "forward"]));
    expect(childCommands).toEqual([]);
    expect(wrapper.get("a[aria-label='Open preview in a new tab']").attributes("href")).toBe("https://abc.webcontainer.io/app");
    wrapper.unmount();
    app.port1.close();
    child.port1.close();
  });

  it("ships a preview script that parses", () => {
    expect(() => new Function(workspacePreviewScript)).not.toThrow();
  });
});
