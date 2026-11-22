// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineConnect } from "@vite-hub/web-container/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, onScopeDispose, type PropType, ref } from "vue";
import { decodePlaygroundLink, encodePlaygroundLink, playgroundUrl } from "../src/playground/share.ts";
import { downloadZip } from "../src/playground/zip.ts";
import type { WorkspaceExample } from "../src/workspace/workspace-examples.ts";
import type { WorkspaceRunner, WorkspaceSlotProps } from "../src/workspace/workspace.ts";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    reset = vi.fn();
    write = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("../src/playground/zip.ts", () => ({ downloadZip: vi.fn() }));

// A container that boots at once, writes to a map, and is ready when the dev server starts. `hold` keeps each boot
// waiting until the test calls `open()`, and `live` counts the containers that are booting or running.
const fake = vi.hoisted(() => ({
  boots: [] as { files: Record<string, string>, snapshot: boolean }[],
  runs: [] as unknown[],
  disk: new Map<string, string>(),
  supported: true,
  hold: false,
  gates: [] as (() => void)[],
  live: 0,
  maxLive: 0,
  open() {
    for (const gate of this.gates.splice(0)) gate();
  },
}));
vi.mock("@vite-hub/web-container", () => ({
  checkWebContainerSupport: () => ({ supported: fake.supported }),
  async bootWebContainer(options: { files: Record<string, string>, snapshot?: unknown, onStatus: (status: unknown) => void }) {
    fake.live++;
    fake.maxLive = Math.max(fake.maxLive, fake.live);
    fake.boots.push({ files: { ...options.files }, snapshot: options.snapshot !== undefined });
    if (fake.hold) await new Promise<void>((resolve) => { fake.gates.push(resolve); });
    for (const [path, contents] of Object.entries(options.files)) fake.disk.set(path, contents);
    options.onStatus({ stage: "mounting", steps: [] });
    let ready: (server: { url: string, port: number }) => void = () => {};
    const serverReady = new Promise<{ url: string, port: number }>((resolve) => { ready = resolve; });
    let url: string | undefined;
    let onServerReady: ((server: { url: string, port: number }) => void) | undefined;
    let down = false;
    return {
      status: { stage: "mounting", steps: [] },
      preview: { ready: serverReady, get url() { return url; } },
      fs: {
        mkdir: async () => {},
        rm: async (path: string) => { fake.disk.delete(path); },
        writeFile: async (path: string, contents: string) => { fake.disk.set(path, contents); },
      },
      on: (event: string, listener: (server: { url: string, port: number }) => void) => {
        if (event === "server-ready") onServerReady = listener;
        return () => {};
      },
      async run(command: unknown) {
        fake.runs.push(command);
        if (command !== "install") {
          url = "https://preview.example";
          ready({ port: 3000, url });
          queueMicrotask(() => onServerReady?.({ port: 3000, url: url! }));
        }
        return { exit: new Promise<number>(() => {}), kill: () => {}, output: new ReadableStream<string>() };
      },
      teardown: () => {
        if (!down) fake.live--;
        down = true;
      },
    };
  },
}));

const { Workspace } = await import("../src/workspace/workspace.ts");
const { webContainer } = await import("../src/workspace/runners/web-container.ts");

// Nuxt UI stand-ins: a button, a menu that lists its items as buttons, a tab strip, and a modal that shows its footer
// when open.
type Item = { label: string, type?: string, disabled?: boolean, onSelect?: () => void };
const UButton = defineComponent({
  props: { label: { default: undefined, type: String } },
  setup: (props, { attrs, slots }) => () => h("button", { "aria-label": attrs["aria-label"], type: "button", onClick: attrs.onClick }, slots.default?.() ?? props.label),
});
const UDropdownMenu = defineComponent({
  props: { items: { required: true, type: Array as PropType<Item[][]> } },
  setup: (props, { slots }) => () => h("div", { class: "menu" }, [
    slots.default?.(),
    ...props.items.flat().filter(item => item.type !== "label").map(item => h("button", { "data-item": item.label, disabled: item.disabled, onClick: item.onSelect }, item.label)),
  ]),
});
type Tab = { label: string, value: string, badge?: string | number };
const UTabs = defineComponent({
  props: { items: { required: true, type: Array as PropType<Tab[]> }, modelValue: { default: undefined, type: String } },
  emits: ["update:modelValue"],
  setup: (props, { emit }) => () => h("div", { role: "tablist" }, props.items.map(item =>
    h("button", { "aria-selected": String(item.value === props.modelValue), role: "tab", type: "button", onClick: () => emit("update:modelValue", item.value) }, [item.label, item.badge === undefined ? null : String(item.badge)]))),
});
const UModal = defineComponent({
  props: { open: Boolean, title: { default: undefined, type: String } },
  setup: (props, { slots }) => () => props.open ? h("div", { role: "dialog" }, [h("h2", props.title), slots.footer?.()]) : null,
});
const UIcon = defineComponent(() => () => h("i"));
const global = {
  components: { UButton, UDropdownMenu, UIcon, UModal, UTabs },
  stubs: { WorkspaceEditor: true, WorkspaceFileTree: true, WorkspacePreview: true },
};

function viewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(/([\d.]+)rem/.exec(query)![1]) * 16,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const kvSnapshot = vi.fn(async () => new Uint8Array([1]));
const agentSnapshot = async () => new Uint8Array([2]);
const kv: WorkspaceExample = {
  id: "kv",
  label: "KV",
  files: { "package.json": "{\"name\":\"kv\"}\n", "server/api/health.get.ts": "export default () => 'ok'\n" },
  open: "server/api/health.get.ts",
  preview: "/api/health",
};
const blob: WorkspaceExample = { ...kv, id: "blob", label: "Blob", files: { ...kv.files, "server/api/note.get.ts": "export default () => 'note'\n" }, open: "server/api/note.get.ts" };
const agent: WorkspaceExample = { id: "agent", label: "Agent", files: { "package.json": "{\"name\":\"agent\"}\n" } };
// KV and Blob have the same dependencies, so they share one snapshot.
const runner = () => webContainer({ snapshot: example => example.id === "agent" ? agentSnapshot : kvSnapshot });
const files = (example: WorkspaceExample) => ({ ...example.files });

/** Keeps the slot props of the bar, which the context of the workspace fills. */
function spy() {
  const box: { context?: WorkspaceSlotProps } = {};
  return { box, slot: (props: WorkspaceSlotProps) => { box.context = props; return []; } };
}

beforeEach(() => {
  vi.mocked(downloadZip).mockClear();
  fake.boots.length = 0;
  fake.runs.length = 0;
  fake.disk.clear();
  fake.supported = true;
  fake.hold = false;
  fake.gates.length = 0;
  fake.live = 0;
  fake.maxLive = 0;
  history.replaceState(null, "", "/play");
  sessionStorage.clear();
  localStorage.clear();
  viewport(1440);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Workspace with webContainer()", () => {
  it("boots the first example on a desktop, tracks edits, and asks before it replaces them", async () => {
    const { box, slot } = spy();
    const wrapper = mount(Workspace, {
      attachTo: document.body,
      global,
      props: { examples: [kv, blob, agent], runner: runner(), name: "vitehub" },
      slots: { "bar-lead": slot },
    });
    await flushPromises();
    expect(fake.boots).toEqual([{ files: kv.files, snapshot: true }]);
    // The snapshot has the dependencies, so nothing installs.
    expect(fake.runs).toEqual(["dev"]);
    expect(wrapper.emitted("update:open")).toEqual([[true]]);
    expect(wrapper.get(".vh-workspace-run-state").text()).toBe("Running");
    expect(wrapper.get(".vh-ws-breadcrumb").attributes("title")).toBe("server/api/health.get.ts");
    expect(wrapper.findAll("[role='tab']").map(tab => tab.text())).toEqual(["Preview", "Terminal"]);

    await box.context!.setFile("server/api/health.get.ts", "export default () => 'edited'\n");
    await flushPromises();
    expect(box.context!.edited).toEqual(["server/api/health.get.ts"]);
    expect(wrapper.findComponent({ name: "WorkspaceFileTree" }).props("edited")).toEqual(["server/api/health.get.ts"]);

    // Blob has the same snapshot and manifest, so it opens in place after the question.
    await wrapper.get("[data-item='Blob']").trigger("click");
    expect(wrapper.get("[role='dialog']").text()).toContain("Open the Blob example?");
    await wrapper.get("[role='dialog'] button:last-child").trigger("click");
    await flushPromises();
    expect(wrapper.emitted("update:example")).toEqual([["blob"]]);
    expect(fake.boots).toHaveLength(1);
    expect(fake.disk.get("server/api/note.get.ts")).toBe(blob.files!["server/api/note.get.ts"]);
    expect(box.context!.edited).toEqual([]);
    expect(wrapper.get(".vh-ws-breadcrumb").attributes("title")).toBe("server/api/note.get.ts");

    // Agent has another snapshot, so it boots again. Without edits there is no question.
    await wrapper.get("[data-item='Agent']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    expect(fake.boots.at(-1)).toEqual({ files: agent.files, snapshot: true });
    expect(wrapper.emitted("update:example")).toEqual([["blob"], ["agent"]]);
    wrapper.unmount();
  });

  it("boots one WebContainer at a time when the reader switches examples during a boot", async () => {
    fake.hold = true;
    const wrapper = mount(Workspace, { global, props: { examples: [kv, agent], runner: runner() } });
    await flushPromises();
    expect(fake.boots).toHaveLength(1);
    // Each switch needs another snapshot, so each one starts a new run while the first boot still waits.
    await wrapper.get("[data-item='Agent']").trigger("click");
    await flushPromises();
    await wrapper.get("[data-item='KV']").trigger("click");
    await flushPromises();
    for (let round = 0; round < 3; round++) {
      fake.open();
      await flushPromises();
    }
    expect(fake.maxLive).toBe(1);
    // The run for Agent stopped before its turn, so it never booted. The last run boots KV.
    expect(fake.boots.map(boot => boot.files)).toEqual([kv.files, kv.files]);
    expect(fake.live).toBe(1);
    expect(wrapper.get(".vh-workspace-run-state").text()).toBe("Running");
    wrapper.unmount();
    expect(fake.live).toBe(0);
  });

  it("copies a link that opens the same files, and restores it on the next visit", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { box, slot } = spy();
    const wrapper = mount(Workspace, { global, props: { examples: [kv, blob], runner: runner() }, slots: { "bar-lead": slot } });
    await flushPromises();
    await box.context!.setFile("server/api/health.get.ts", "edited");
    await wrapper.findAll("button").find(button => button.text() === "Copy link")!.trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    await flushPromises();
    const url = new URL(writeText.mock.calls[0]![0]);
    expect(url.pathname).toBe("/play");
    const templates = [kv, blob].map(example => ({ id: example.id, files: files(example) }));
    expect(await decodePlaygroundLink(url.hash.slice("#code=".length), templates)).toEqual({ template: "kv", files: { ...kv.files, "server/api/health.get.ts": "edited" } });
    expect(wrapper.text()).toContain("Link copied");
    wrapper.unmount();

    fake.boots.length = 0;
    fake.runs.length = 0;
    history.replaceState(null, "", playgroundUrl("/play", await encodePlaygroundLink({ template: "blob", files: { ...blob.files, "package.json": "{}" } }, files(blob))));
    const restored = mount(Workspace, { global, props: { examples: [kv, blob], runner: runner() } });
    // The link inflates in a stream, so it takes more than one tick.
    await vi.waitFor(() => expect(restored.text()).toContain("You opened shared files on the Blob example."));
    await flushPromises();
    // The shared manifest differs from the snapshot, so the workspace installs the difference.
    expect(fake.boots).toEqual([{ files: { ...blob.files, "package.json": "{}" }, snapshot: true }]);
    expect(fake.runs).toEqual(["install"]);
    restored.unmount();

    history.replaceState(null, "", "/play#code=broken");
    const invalid = mount(Workspace, { global, props: { examples: [kv, blob], runner: runner() } });
    await vi.waitFor(() => expect(invalid.text()).toContain("This link has no files that the workspace can read. It opened the KV example."));
    invalid.unmount();
  });

  it("boots the current lesson files when a tablet opens after a step change", async () => {
    viewport(900);
    const { box, slot } = spy();
    const wrapper = mount(Workspace, { global, props: { examples: [kv], runner: runner(), share: false }, slots: { "bar-lead": slot } });
    await flushPromises();
    expect(box.context).toBeUndefined();
    const next = { ...kv, files: { ...kv.files, "server/api/health.get.ts": "next step" } };
    await wrapper.setProps({ examples: [next] });
    await wrapper.findAll("button").find(button => button.text() === "Open workspace")!.trigger("click");
    await flushPromises();
    expect(fake.boots).toEqual([{ files: next.files, snapshot: true }]);
    expect(box.context!.edited).toEqual([]);
    wrapper.unmount();
  });

  it("downloads the current lesson files on a phone without booting", async () => {
    viewport(390);
    const wrapper = mount(Workspace, { global, props: { examples: [kv], runner: runner(), share: false } });
    await flushPromises();
    const next = { ...kv, files: { ...kv.files, "server/api/health.get.ts": "next step" } };
    await wrapper.setProps({ examples: [next] });
    await wrapper.findAll("button").find(button => button.text() === "Download files")!.trigger("click");
    expect(downloadZip).toHaveBeenCalledWith(next.files, next.id);
    expect(fake.boots).toHaveLength(0);
    wrapper.unmount();
  });

  it("updates the selected model when a new run cannot open the previous path", async () => {
    const selected = ref(kv.open);
    const workspaceRunner = runner();
    const wrapper = mount(defineComponent(() => () => h(Workspace, {
      examples: [kv, agent],
      runner: workspaceRunner,
      selected: selected.value,
      "onUpdate:selected": (path: string) => { selected.value = path; },
    })), { global });
    await flushPromises();
    expect(selected.value).toBe(kv.open);
    await wrapper.get("[data-item='Agent']").trigger("click");
    await flushPromises();
    expect(fake.boots.at(-1)?.files).toEqual(agent.files);
    expect(wrapper.get(".vh-ws-breadcrumb").attributes("title")).toBe("package.json");
    expect(selected.value).toBe("package.json");
    wrapper.unmount();
  });

  it("puts the preview in the first tab, and adds Connect, the tabs of the page, and the bar slots", async () => {
    const wrapper = mount(Workspace, {
      global,
      props: {
        guide: "side",
        examples: [kv],
        runner: webContainer({ connect: defineConnect({ github: true }) }),
        share: false,
        tabs: [{ label: "Messages", value: "messages" }, { label: "Status", value: "status" }, { label: "Path", value: "editor-head" }],
      },
      slots: {
        messages: () => h("p", "messages"),
        status: () => h("button", "Custom status"),
        "editor-head": () => h("p", "Custom path"),
        "bar-actions": ({ edited }: WorkspaceSlotProps) => h("span", { class: "extra" }, `${edited.length} edited`),
      },
    });
    await flushPromises();
    expect(wrapper.get(".vh-ws-shell").attributes("data-layout")).toBe("guide-side");
    expect(wrapper.findAll("[role='tab']").map(tab => tab.text())).toEqual(["Preview", "Terminal", "Connect", "Messages", "Status", "Path"]);
    expect(wrapper.get("[data-tab='messages']").text()).toBe("messages");
    expect(wrapper.get(".vh-ws-editor-head .vh-ws-breadcrumb").attributes("title")).toBe("server/api/health.get.ts");
    expect(wrapper.get(".vh-ws-status").text()).not.toContain("Custom status");
    expect(wrapper.get("[data-tab='status']").attributes()).toHaveProperty("inert");
    expect(wrapper.get("[data-tab='status']").text()).toBe("Custom status");
    expect(wrapper.get("[data-tab='editor-head']").text()).toBe("Custom path");
    expect(wrapper.get(".extra").text()).toBe("0 edited");
    expect(wrapper.text()).not.toContain("Copy link");
    expect(wrapper.find(".vh-ws-topbar [data-item='Restart dev server']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("moves Reset, Download and Copy link to the bottom of the sidebar when the page gives one", async () => {
    const bar = (wrapper: ReturnType<typeof mount>) => wrapper.get(".vh-ws-topbar").findAll("button").map(button => button.text());
    const plain = mount(Workspace, { global, props: { examples: [kv], runner: runner() } });
    await flushPromises();
    expect(bar(plain)).toEqual(expect.arrayContaining(["Reset", "Download", "Copy link"]));
    plain.unmount();

    const wrapper = mount(Workspace, { global, props: { examples: [kv], runner: runner() }, slots: { sidebar: () => h("nav", { class: "pages" }, "Pages") } });
    await flushPromises();
    expect(bar(wrapper)).not.toContain("Reset");
    expect(bar(wrapper)).not.toContain("Copy link");
    const sidebar = wrapper.get("#vh-workspace-sidebar");
    expect(sidebar.get(".pages").text()).toBe("Pages");
    expect(sidebar.findAll("button").map(button => button.text())).toEqual(["Reset", "Download", "Copy link"]);
    wrapper.unmount();
  });

  it("shows the start screen on a first visit, opens the picked example, and skips the screen for a share link", async () => {
    const wrapper = mount(Workspace, { global, props: { examples: [kv, blob], runner: runner(), start: true } });
    await flushPromises();
    expect(wrapper.findAll(".vh-ws-start-label").map(label => label.text())).toEqual(["KV", "Blob"]);
    expect(wrapper.findAll(".vh-ws-start-files").map(count => count.text())).toEqual(["2 files", "3 files"]);
    await wrapper.findAll(".vh-ws-start-card")[1]!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".vh-ws-start").exists()).toBe(false);
    expect(wrapper.emitted("update:example")).toEqual([["blob"]]);
    expect(wrapper.get(".vh-ws-breadcrumb").attributes("title")).toBe("server/api/note.get.ts");
    wrapper.unmount();

    history.replaceState(null, "", playgroundUrl("/play", await encodePlaygroundLink({ template: "blob", files: files(blob) }, files(blob))));
    const shared = mount(Workspace, { global, props: { examples: [kv, blob], runner: runner(), start: true } });
    await vi.waitFor(() => expect(shared.text()).toContain("on the Blob example"));
    await flushPromises();
    expect(shared.find(".vh-ws-start").exists()).toBe(false);
    expect(fake.boots.at(-1)).toEqual({ files: blob.files, snapshot: true });
    shared.unmount();
  });

  it("starts only the picked example when the first example's snapshot would still be downloading", async () => {
    // One WebContainer runs at a time, so a second start while a run is live throws, as the browser API does.
    const started: string[] = [];
    let live = 0;
    const delayedSnapshot = vi.fn(() => new Promise<Uint8Array>(() => {}));
    const inner = webContainer({ snapshot: example => example.id === "agent" ? agentSnapshot : delayedSnapshot });
    const single: WorkspaceRunner = {
      ...inner,
      start(input) {
        if (live > 0) throw new Error("Only a single WebContainer instance can be booted");
        live++;
        started.push(input.example.id);
        onScopeDispose(() => { live--; });
        return inner.start(input);
      },
    };
    const wrapper = mount(Workspace, { global, props: { examples: [kv, agent], runner: single, start: true } });
    await flushPromises();

    await wrapper.findAll(".vh-ws-start-card")[1]!.trigger("click");
    await flushPromises();

    expect(started).toEqual(["agent"]);
    expect(fake.boots).toEqual([{ files: agent.files, snapshot: true }]);
    expect(delayedSnapshot).not.toHaveBeenCalled();
    expect(wrapper.findComponent({ name: "WorkspacePreview" }).exists()).toBe(true);
    wrapper.unmount();
  });

  it.each(["card", "menu"])("keeps the panes out of the chooser and hands off focus after a %s pick", async (picker) => {
    const wrapper = mount(Workspace, { attachTo: document.body, global, props: { examples: [kv, blob], runner: runner(), start: true } });
    await flushPromises();
    expect(wrapper.find(".vh-ws-shell").exists()).toBe(false);
    expect(fake.boots).toEqual([]);

    const choice = wrapper.get(picker === "card" ? ".vh-ws-start-card" : '[data-item="KV"]');
    (choice.element as HTMLButtonElement).focus();
    await choice.trigger("click");
    await flushPromises();

    expect(wrapper.find(".vh-ws-start").exists()).toBe(false);
    expect(wrapper.emitted("update:example")).toEqual([["kv"]]);
    expect(document.activeElement).toBe(wrapper.get('button[aria-label="Example: KV"]').element);
    wrapper.unmount();
  });

  it("boots on a tablet only after a tap, never on a phone, and shows a notice where WebContainers do not run", async () => {
    viewport(900);
    const tablet = mount(Workspace, { global, props: { examples: [kv], runner: runner(), label: "playground" } });
    await flushPromises();
    expect(fake.boots).toHaveLength(0);
    await tablet.findAll("button").find(button => button.text() === "Open playground")!.trigger("click");
    await flushPromises();
    expect(fake.boots).toHaveLength(1);
    expect(tablet.emitted("update:open")).toEqual([[true]]);
    tablet.unmount();

    viewport(390);
    const phone = mount(Workspace, { global, props: { examples: [kv], runner: runner(), label: "playground", open: true }, slots: { intro: () => h("h1", "Playground") } });
    await flushPromises();
    expect(phone.get(".vh-workspace-gate").attributes("data-state")).toBe("phone");
    expect(phone.text()).toContain("Playground");
    expect(phone.text()).toContain("The live playground runs in a desktop browser.");
    expect(fake.boots).toHaveLength(1);
    phone.unmount();

    viewport(1440);
    fake.supported = false;
    const unsupported = mount(Workspace, { global, props: { examples: [kv], runner: runner() } });
    await flushPromises();
    expect(unsupported.get(".vh-workspace-gate").attributes("data-state")).toBe("unsupported");
    expect(unsupported.text()).toContain("Download files");
    expect(fake.boots).toHaveLength(1);
    unsupported.unmount();
  });

  it("gives useWorkspace() and the runner state to code inside and outside the workspace", async () => {
    const workspaceRunner = runner();
    const { useWorkspace } = await import("../src/workspace/workspace.ts");
    let fromInside: ReturnType<typeof useWorkspace> | undefined;
    const Inside = defineComponent(() => {
      fromInside = useWorkspace();
      return () => h("span");
    });
    const wrapper = mount(Workspace, { global, props: { examples: [kv], runner: workspaceRunner }, slots: { "bar-lead": () => h(Inside) } });
    await flushPromises();
    expect(fromInside!.files.value).toEqual(kv.files);
    expect(workspaceRunner.workspace.value?.status.value).toBe("ready");
    fromInside!.show("package.json");
    await flushPromises();
    expect(wrapper.get(".vh-ws-breadcrumb").attributes("title")).toBe("package.json");
    wrapper.unmount();
    expect(workspaceRunner.workspace.value).toBeUndefined();
  });
});
