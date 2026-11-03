// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import type { WebContainerStatus, WebContainerStep } from "@vite-hub/web-container";
import { defineConnect } from "@vite-hub/web-container/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { BrowserSupportNotice, detectUnsupportedBrowser } from "../src/workspace/browser-support-notice.ts";
import { ConnectPanel } from "../src/workspace/connect-panel.ts";
import { useConnectStore } from "../src/workspace/connect-store.ts";
import { bootChecklist, formatElapsed, WorkspaceBootStatus } from "../src/workspace/workspace-boot-status.ts";
import { WorkspacePreview } from "../src/workspace/workspace-preview.ts";
import { WorkspaceShell } from "../src/workspace/workspace-shell.ts";

// A fake container: the tests control when each process exits.
const fake = vi.hoisted(() => {
  const state = {
    disk: new Map<string, string>(),
    exits: [] as { command: unknown, env?: Record<string, string>, resolve: (code: number) => void }[],
    mountFiles: undefined as Record<string, string> | undefined,
    releaseBoot: undefined as (() => void) | undefined,
    statusListener: undefined as ((status: WebContainerStatus) => void) | undefined,
  };
  return state;
});

vi.mock("@vite-hub/web-container", () => ({
  checkWebContainerSupport: () => ({ supported: true }),
  async bootWebContainer(options: { files: Record<string, string>, onStatus: (status: WebContainerStatus) => void }) {
    fake.mountFiles = { ...options.files };
    for (const [path, contents] of Object.entries(options.files)) fake.disk.set(path, contents);
    options.onStatus({ stage: "booting", steps: [{ stage: "booting", startedAt: 0 }] });
    await new Promise<void>((resolve) => { fake.releaseBoot = resolve; });
    let ready: (value: { url: string, port: number }) => void = () => {};
    const readyPromise = new Promise<{ url: string, port: number }>((resolve) => { ready = resolve; });
    return {
      status: { stage: "mounting", steps: [] },
      preview: { ready: readyPromise, url: "https://preview.example" },
      fs: {
        mkdir: async () => {},
        rm: async (path: string) => { fake.disk.delete(path); },
        writeFile: async (path: string, contents: string) => { fake.disk.set(path, contents); },
      },
      on: (_event: string, listener: (status: WebContainerStatus) => void) => { fake.statusListener = listener; return () => {}; },
      async run(command: unknown, options: { env?: Record<string, string> } = {}) {
        let resolve: (code: number) => void = () => {};
        const exit = new Promise<number>((done) => { resolve = done; });
        fake.exits.push({ command, env: options.env, resolve });
        if (command === "dev") ready({ port: 3000, url: "https://preview.example" });
        return { exit, kill: () => resolve(143), output: new ReadableStream<string>({ start(controller) { controller.enqueue(`$ ${String(command)}\n`); } }) };
      },
      teardown: () => {},
    };
  },
}));

const { useWorkspace } = await import("../src/workspace/use-workspace.ts");

function mountWorkspace(options: Parameters<typeof useWorkspace>[0]) {
  let workspace!: ReturnType<typeof useWorkspace>;
  const wrapper = mount(defineComponent({
    setup() {
      workspace = useWorkspace(options);
      return () => h("div");
    },
  }));
  return { workspace, wrapper };
}

beforeEach(() => {
  fake.disk.clear();
  fake.exits.length = 0;
  fake.mountFiles = undefined;
  fake.releaseBoot = undefined;
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("useWorkspace", () => {
  it("writes edits made before mount when the mount ends, and tracks modified files", async () => {
    const { workspace, wrapper } = mountWorkspace({ files: { "a.txt": "a", "b.txt": "b" } });
    await flushPromises();
    expect(workspace.status.value).toBe("booting");

    await workspace.setFiles({ "a.txt": "edited", "new/c.txt": "c" });
    expect(fake.mountFiles).toEqual({ "a.txt": "a", "b.txt": "b" });
    expect(workspace.modified.value).toEqual(["a.txt", "new/c.txt"]);

    fake.releaseBoot?.();
    await flushPromises();
    expect(fake.disk.get("a.txt")).toBe("edited");
    expect(fake.disk.get("new/c.txt")).toBe("c");
    expect(fake.exits.map(run => run.command)).toEqual(["install"]);

    await workspace.setFiles({ "a.txt": "a" }, { mode: "replace" });
    expect([...fake.disk.keys()]).toEqual(["a.txt"]);
    await workspace.reset();
    expect(Object.fromEntries(fake.disk)).toEqual({ "a.txt": "a", "b.txt": "b" });
    expect(workspace.modified.value).toEqual([]);
    wrapper.unmount();
  });

  it("reports an install failure with its exit code, and retries the install", async () => {
    const { workspace, wrapper } = mountWorkspace({ env: () => ({ OPENAI_API_KEY: "sk-test" }), files: { "a.txt": "a" } });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    fake.exits[0]?.resolve(1);
    await flushPromises();
    expect(workspace.failure.value).toMatchObject({ exitCode: 1, kind: "install" });
    expect(workspace.status.value).toBe("error");

    void workspace.install();
    await flushPromises();
    expect(workspace.failure.value).toBeUndefined();
    fake.exits[1]?.resolve(0);
    await flushPromises();
    expect(fake.exits.map(run => run.command)).toEqual(["install", "install", "dev"]);
    expect(fake.exits[2]?.env).toEqual({ OPENAI_API_KEY: "sk-test" });
    expect(workspace.previewUrl.value).toBe("https://preview.example");
    wrapper.unmount();
  });

  it("reports a stopped dev server and restarts it", async () => {
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    expect(fake.exits.map(run => run.command)).toEqual(["dev"]);

    fake.exits[0]?.resolve(1);
    await flushPromises();
    expect(workspace.failure.value).toMatchObject({ exitCode: 1, kind: "server" });
    expect(workspace.previewUrl.value).toBeUndefined();

    await workspace.restart();
    await flushPromises();
    expect(workspace.failure.value).toBeUndefined();
    expect(fake.exits.map(run => run.command)).toEqual(["dev", "dev"]);

    // A restart that the app asks for is not a failure.
    await workspace.restart();
    await flushPromises();
    expect(workspace.failure.value).toBeUndefined();
    wrapper.unmount();
  });

  it("collects process output in order", async () => {
    vi.useFakeTimers();
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.logs.value.join("")).toBe("$ dev\n");
    wrapper.unmount();
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

describe("ConnectPanel", () => {
  const connect = defineConnect({ anthropic: true, cloudflare: { relay: "reader" }, github: true, openai: true, vercel: true });

  it("groups providers and shows one status line and one action per state", async () => {
    const wrapper = mount(ConnectPanel, {
      props: {
        connect,
        relayUrl: "https://vitehub.dev/docs/relay",
        states: {
          github: { message: "GitHub blocked the request", status: "blocked", command: "npx vitehub deploy" },
          openai: { account: "acme", status: "connected" },
          vercel: { status: "error" },
        },
      },
    });
    expect(wrapper.findAll("h3").map(heading => heading.text())).toEqual(["Deploy", "Source", "Model keys"]);
    const row = (name: string) => wrapper.get(`[data-provider='${name}']`);
    expect(row("anthropic").text()).toContain("Paste a token");
    expect(row("cloudflare").text()).toContain("Needs a relay. Cloudflare does not accept browser requests.");
    expect(row("cloudflare").get("a").attributes("href")).toBe("https://vitehub.dev/docs/relay");
    expect(row("openai").text()).toContain("acme · OPENAI_API_KEY");
    expect(row("vercel").text()).toContain("Vercel rejected the token. Paste a new one.");
    expect(row("github").text()).toContain("Set up relay");
    await row("github").findAll("button").find(button => button.text() === "Copy command")?.trigger("click");
    expect(wrapper.emitted("copy-command")).toEqual([["npx vitehub deploy"]]);

    await row("openai").get("button").trigger("click");
    expect(wrapper.emitted("disconnect")).toEqual([["openai"]]);
    await wrapper.findAll("button").find(button => button.text() === "Remove all")?.trigger("click");
    expect(wrapper.emitted("remove-all")).toHaveLength(1);
    expect(wrapper.get("footer").text()).toContain("ViteHub servers never receive them.");
  });

  it("asks for a token in a labeled password input", async () => {
    const wrapper = mount(ConnectPanel, { attachTo: document.body, props: { connect } });
    await wrapper.get("[aria-label='Connect Anthropic']").trigger("click");
    const input = wrapper.get("input");
    expect(input.attributes()).toMatchObject({ autocomplete: "off", type: "password" });
    expect(wrapper.get(`label[for='${input.attributes("id")}']`).text()).toBe("Anthropic token");
    expect(wrapper.get(".vh-ws-token-form a").text()).toBe("Create a token");
    await input.setValue("sk-ant-1");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("connect")).toEqual([["anthropic", "sk-ant-1"]]);
    expect(wrapper.find("input").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps tokens in sessionStorage and maps them to env", () => {
    const store = useConnectStore();
    store.set("openai", "sk-1");
    expect(JSON.parse(sessionStorage.getItem("vitehub:connect") ?? "{}")).toEqual({ openai: "sk-1" });
    expect(useConnectStore().credentials.value).toEqual({ openai: "sk-1" });
    const env = store.env(connect);
    expect(env.value).toEqual({ OPENAI_API_KEY: "sk-1" });
    store.remove("openai");
    expect(env.value).toEqual({});
    store.set("github", "ghp");
    store.clear();
    expect(sessionStorage.getItem("vitehub:connect")).toBeNull();
    expect(localStorage.length).toBe(0);
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
    const tabs = wrapper.findAll("[role='tab']");
    expect(tabs.map(tab => tab.text())).toEqual(["Preview", "Terminal", "Connect"]);
    expect(wrapper.get("[data-tab='terminal']").attributes()).toHaveProperty("inert");
    expect(wrapper.get("[data-tab='preview']").attributes()).not.toHaveProperty("inert");

    await tabs[1]?.trigger("click");
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

  it("puts the terminal under the editor in a playground", () => {
    const wrapper = mount(WorkspaceShell, {
      props: { layout: "playground", storageKey: false },
      slots: { editor: () => h("p", "editor"), preview: () => h("p", "preview"), terminal: () => h("p", "terminal") },
    });
    expect(wrapper.findAll("[role='tab']").map(tab => tab.text())).toEqual(["Preview"]);
    expect(wrapper.get(".vh-ws-pane--terminal").text()).toBe("terminal");
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

    await wrapper.get("input").setValue("todos");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("update:path")).toEqual([["/todos"]]);

    await wrapper.get("[aria-label='Reload preview']").trigger("click");
    expect(wrapper.get("iframe").element).not.toBe(frame.element);
  });
});
