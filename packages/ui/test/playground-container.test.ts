// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineConnect } from "@vite-hub/web-container/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, type PropType, ref } from "vue";
import { decodePlaygroundLink, encodePlaygroundLink, playgroundUrl } from "../src/playground/share.ts";
import { downloadZip } from "../src/playground/zip.ts";
import type { PlaygroundContainerTemplate, PlaygroundContext } from "../src/workspace/playground-container.ts";

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

// A container that boots at once, writes to a map, and is ready when the dev server starts.
const fake = vi.hoisted(() => ({ boots: [] as { files: Record<string, string>, snapshot: boolean }[], runs: [] as unknown[], disk: new Map<string, string>(), supported: true }));
vi.mock("@vite-hub/web-container", () => ({
  checkWebContainerSupport: () => ({ supported: fake.supported }),
  async bootWebContainer(options: { files: Record<string, string>, snapshot?: unknown, onStatus: (status: unknown) => void }) {
    fake.boots.push({ files: { ...options.files }, snapshot: options.snapshot !== undefined });
    for (const [path, contents] of Object.entries(options.files)) fake.disk.set(path, contents);
    options.onStatus({ stage: "mounting", steps: [] });
    let ready: (server: { url: string, port: number }) => void = () => {};
    const serverReady = new Promise<{ url: string, port: number }>((resolve) => { ready = resolve; });
    let url: string | undefined;
    let onServerReady: ((server: { url: string, port: number }) => void) | undefined;
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
      teardown: () => {},
    };
  },
}));

const { PlaygroundContainer } = await import("../src/workspace/playground-container.ts");

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
const global = {
  components: { UButton, UDropdownMenu, UModal, UTabs },
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
const kv: PlaygroundContainerTemplate = {
  id: "kv",
  label: "KV",
  files: { "package.json": "{\"name\":\"kv\"}\n", "server/api/health.get.ts": "export default () => 'ok'\n" },
  open: "server/api/health.get.ts",
  preview: "/api/health",
  snapshot: kvSnapshot,
};
const blob: PlaygroundContainerTemplate = { ...kv, id: "blob", label: "Blob", files: { ...kv.files, "server/api/note.get.ts": "export default () => 'note'\n" }, open: "server/api/note.get.ts" };
const agent: PlaygroundContainerTemplate = { id: "agent", label: "Agent", files: { "package.json": "{\"name\":\"agent\"}\n" }, snapshot: async () => new Uint8Array([2]) };

beforeEach(() => {
  vi.mocked(downloadZip).mockClear();
  fake.boots.length = 0;
  fake.runs.length = 0;
  fake.disk.clear();
  fake.supported = true;
  history.replaceState(null, "", "/play");
  sessionStorage.clear();
  localStorage.clear();
  viewport(1440);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("PlaygroundContainer", () => {
  it("boots the first template on a desktop, tracks edits, and asks before it replaces them", async () => {
    let context: PlaygroundContext | undefined;
    const wrapper = mount(PlaygroundContainer, {
      attachTo: document.body,
      global,
      props: { templates: [kv, blob, agent], name: "vitehub", onContext: (value: PlaygroundContext) => { context = value; } },
    });
    await flushPromises();
    expect(fake.boots).toEqual([{ files: kv.files, snapshot: true }]);
    // The snapshot has the dependencies, so nothing installs.
    expect(fake.runs).toEqual(["dev"]);
    expect(wrapper.emitted("update:open")).toEqual([[true]]);
    expect(wrapper.get(".vh-pc-run-state").text()).toBe("Running");
    expect(wrapper.get(".vh-pc-path").text()).toBe("server/api/health.get.ts");
    expect(wrapper.findAll("[role='tab']").map(tab => tab.text())).toEqual(["Console"]);

    await context!.workspace.setFiles({ "server/api/health.get.ts": "export default () => 'edited'\n" });
    await flushPromises();
    expect(context!.edited).toEqual(["server/api/health.get.ts"]);
    expect(wrapper.text()).toContain("Edited");

    // Blob has the same snapshot and manifest, so it opens in place after the question.
    await wrapper.get("[data-item='Blob']").trigger("click");
    expect(wrapper.get("[role='dialog']").text()).toContain("Open the Blob template?");
    await wrapper.get("[role='dialog'] button:last-child").trigger("click");
    await flushPromises();
    expect(wrapper.emitted("update:template")).toEqual([["blob"]]);
    expect(fake.boots).toHaveLength(1);
    expect(fake.disk.get("server/api/note.get.ts")).toBe(blob.files["server/api/note.get.ts"]);
    expect(context!.edited).toEqual([]);
    expect(wrapper.get(".vh-pc-path").text()).toBe("server/api/note.get.ts");

    // Agent has another snapshot, so it boots again. Without edits there is no question.
    await wrapper.get("[data-item='Agent']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    expect(fake.boots.at(-1)).toEqual({ files: agent.files, snapshot: true });
    expect(wrapper.emitted("update:template")).toEqual([["blob"], ["agent"]]);
    wrapper.unmount();
  });

  it("copies a link that opens the same files, and restores it on the next visit", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    let context: PlaygroundContext | undefined;
    const wrapper = mount(PlaygroundContainer, {
      global,
      props: { templates: [kv, blob], onContext: (value: PlaygroundContext) => { context = value; } },
    });
    await flushPromises();
    await context!.workspace.setFiles({ "server/api/health.get.ts": "edited" });
    await wrapper.findAll("button").find(button => button.text() === "Copy link")!.trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    await flushPromises();
    const url = new URL(writeText.mock.calls[0]![0]);
    expect(url.pathname).toBe("/play");
    expect(await decodePlaygroundLink(url.hash.slice("#code=".length), [kv, blob])).toEqual({ template: "kv", files: { ...kv.files, "server/api/health.get.ts": "edited" } });
    expect(wrapper.text()).toContain("Link copied");
    wrapper.unmount();

    fake.boots.length = 0;
    fake.runs.length = 0;
    history.replaceState(null, "", playgroundUrl("/play", await encodePlaygroundLink({ template: "blob", files: { ...blob.files, "package.json": "{}" } }, blob.files)));
    const restored = mount(PlaygroundContainer, { global, props: { templates: [kv, blob] } });
    // The link inflates in a stream, so it takes more than one tick.
    await vi.waitFor(() => expect(restored.text()).toContain("You opened shared files on the Blob template."));
    await flushPromises();
    // The shared manifest differs from the snapshot, so the workspace installs the difference.
    expect(fake.boots).toEqual([{ files: { ...blob.files, "package.json": "{}" }, snapshot: true }]);
    expect(fake.runs).toEqual(["install"]);
    restored.unmount();

    history.replaceState(null, "", "/play#code=broken");
    const invalid = mount(PlaygroundContainer, { global, props: { templates: [kv, blob] } });
    await vi.waitFor(() => expect(invalid.text()).toContain("This link has no files that the workspace can read. It opened the KV template."));
    invalid.unmount();
  });

  it("boots the current tutorial files when a tablet opens after a step change", async () => {
    viewport(900);
    let context: PlaygroundContext | undefined;
    const wrapper = mount(PlaygroundContainer, {
      global,
      props: { templates: [kv], share: false, onContext: (value: PlaygroundContext) => { context = value; } },
    });
    await flushPromises();
    expect(context).toBeUndefined();
    const next = { ...kv, files: { ...kv.files, "server/api/health.get.ts": "next step" } };
    await wrapper.setProps({ templates: [next] });
    await wrapper.findAll("button").find(button => button.text() === "Open workspace")!.trigger("click");
    await flushPromises();
    expect(fake.boots).toEqual([{ files: next.files, snapshot: true }]);
    expect(context!.edited).toEqual([]);
    wrapper.unmount();
  });

  it("downloads the current tutorial files on a phone without booting", async () => {
    viewport(390);
    const wrapper = mount(PlaygroundContainer, { global, props: { templates: [kv], share: false } });
    await flushPromises();
    const next = { ...kv, files: { ...kv.files, "server/api/health.get.ts": "next step" } };
    await wrapper.setProps({ templates: [next] });
    await wrapper.findAll("button").find(button => button.text() === "Download files")!.trigger("click");
    expect(downloadZip).toHaveBeenCalledWith(next.files, next.id);
    expect(fake.boots).toHaveLength(0);
    wrapper.unmount();
  });

  it("updates the selected model when a new boot cannot open the previous path", async () => {
    const selected = ref(kv.open);
    const wrapper = mount(defineComponent(() => () => h(PlaygroundContainer, {
      templates: [kv, agent],
      selected: selected.value,
      "onUpdate:selected": (path: string) => { selected.value = path; },
    })), { global });
    await flushPromises();
    expect(selected.value).toBe(kv.open);
    await wrapper.get("[data-item='Agent']").trigger("click");
    await flushPromises();
    expect(fake.boots.at(-1)?.files).toEqual(agent.files);
    expect(wrapper.get(".vh-pc-path").text()).toBe("package.json");
    expect(selected.value).toBe("package.json");
    wrapper.unmount();
  });

  it("puts the preview in a tab in a tutorial, and adds Connect and the tabs of the page", async () => {
    const wrapper = mount(PlaygroundContainer, {
      global,
      props: {
        layout: "tutorial",
        templates: [kv],
        share: false,
        connect: defineConnect({ github: true }),
        tabs: [{ label: "Messages", value: "messages" }],
      },
      slots: {
        messages: () => h("p", "messages"),
        toolbar: ({ edited }: PlaygroundContext) => h("span", { class: "extra" }, `${edited.length} edited`),
      },
    });
    await flushPromises();
    expect(wrapper.findAll("[role='tab']").map(tab => tab.text())).toEqual(["Preview", "Console", "Connect", "Messages"]);
    expect(wrapper.get("[data-tab='messages']").text()).toBe("messages");
    expect(wrapper.get(".extra").text()).toBe("0 edited");
    expect(wrapper.text()).not.toContain("Copy link");
    expect(wrapper.find(".vh-pc-toolbar .menu").exists()).toBe(true);
    wrapper.unmount();
  });

  it("boots on a tablet only after a tap, never on a phone, and shows a notice where WebContainers do not run", async () => {
    viewport(900);
    const tablet = mount(PlaygroundContainer, { global, props: { templates: [kv], label: "playground" } });
    await flushPromises();
    expect(fake.boots).toHaveLength(0);
    await tablet.findAll("button").find(button => button.text() === "Open playground")!.trigger("click");
    await flushPromises();
    expect(fake.boots).toHaveLength(1);
    expect(tablet.emitted("update:open")).toEqual([[true]]);
    tablet.unmount();

    viewport(390);
    const phone = mount(PlaygroundContainer, { global, props: { templates: [kv], label: "playground", open: true }, slots: { intro: () => h("h1", "Playground") } });
    await flushPromises();
    expect(phone.get(".vh-pc-gate").attributes("data-state")).toBe("phone");
    expect(phone.text()).toContain("Playground");
    expect(phone.text()).toContain("The live playground runs in a desktop browser.");
    expect(fake.boots).toHaveLength(1);
    phone.unmount();

    viewport(1440);
    fake.supported = false;
    const unsupported = mount(PlaygroundContainer, { global, props: { templates: [kv] } });
    await flushPromises();
    expect(unsupported.get(".vh-pc-gate").attributes("data-state")).toBe("unsupported");
    expect(unsupported.text()).toContain("Download files");
    expect(fake.boots).toHaveLength(1);
    unsupported.unmount();
  });
});
