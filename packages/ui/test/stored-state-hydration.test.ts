// @vitest-environment happy-dom
import { renderToString } from "@vue/server-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { type Component, createSSRApp, defineComponent, h, nextTick } from "vue";
import { AgentSession } from "../src/components/agent-session.ts";
import { DeviceFrame } from "../src/components/device-frame.ts";
import { uiComponentsKey } from "../src/internal/nuxt-ui.ts";
import { useConnectStore } from "../src/workspace/connect-store.ts";
import { WorkspacePreview } from "../src/workspace/workspace-preview.ts";

const stub = (name: string) => defineComponent({ name, inheritAttrs: false, setup: (_, { slots }) => () => h("span", { "data-stub": name }, slots.default?.()) });
const stubs = Object.fromEntries(["UButton", "UDropdownMenu", "UIcon", "UInput", "UModal"].map((name) => [name, stub(name)]));

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function hydrate(render: () => ReturnType<typeof h>, stored: () => void) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const app = () => createSSRApp({ render }).provide(uiComponentsKey, stubs);
  const html = await renderToString(app());
  stored();
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  app().mount(container);
  const mismatches = [...warn.mock.calls, ...error.mock.calls].flat().map(String).filter((line) => /hydration/i.test(line));
  await nextTick();
  return { container, mismatches };
}

const component = (part: Component, props: Record<string, unknown>) => () => h(part, props);

it("hydrates AgentSession, then opens the stored panel at the stored width", async () => {
  const surfaces = [{ id: "files", label: "Files" }];
  const { container, mismatches } = await hydrate(component(AgentSession, { title: "Session", surfaces, storageKey: "layout" }), () => {
    localStorage.setItem("layout", JSON.stringify({ panelOpen: true, tabs: ["files"], active: "files", width: 480 }));
  });
  expect(mismatches).toEqual([]);
  expect(container.querySelector("[data-slot='agent-session-panel']")).not.toBeNull();
  expect(container.querySelector<HTMLElement>(".vh-agent-session")?.style.getPropertyValue("--vh-agent-panel-width")).toBe("480px");
});

it("hydrates DeviceFrame, then shows the stored device size", async () => {
  const { container, mismatches } = await hydrate(component(DeviceFrame, { storageKey: "frame" }), () => {
    localStorage.setItem("frame", JSON.stringify({ on: true, id: "iphone", width: 390, height: 844, zoom: null }));
  });
  expect(mismatches).toEqual([]);
  expect(container.querySelector<HTMLElement>(".vh-device-frame__page")?.style.width).toBe("390px");
});

it("hydrates WorkspacePreview, then shows the stored device width", async () => {
  const { container, mismatches } = await hydrate(component(WorkspacePreview, { url: "https://abc.webcontainer.io" }), () => {
    localStorage.setItem("vitehub:workspace-preview:device", "phone");
  });
  expect(mismatches).toEqual([]);
  expect(container.querySelector("[aria-label='Phone']")?.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector<HTMLElement>(".vh-device-frame__page")?.style.width).toBe("390px");
});

it("hydrates a component that uses useConnectStore, then loads the stored tokens", async () => {
  const Providers = defineComponent({
    setup() {
      const store = useConnectStore();
      return () => h("p", Object.keys(store.credentials.value).join(",") || "none");
    },
  });
  const { container, mismatches } = await hydrate(() => h(Providers), () => {
    sessionStorage.setItem("vitehub:connect", JSON.stringify({ openai: "sk-1" }));
  });
  expect(mismatches).toEqual([]);
  expect(container.textContent).toBe("openai");
});
