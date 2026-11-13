import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch, type PropType } from "vue";
import { DeviceFrame, type DeviceFramePreset, type DeviceFrameSize } from "../components/device-frame.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { icon, type WorkspaceIconName } from "./icons.ts";

function join(base: string, path: string) {
  try {
    return new URL(path || "/", base).href;
  }
  catch {
    return base;
  }
}

/**
 * Runs first in every HTML page of the preview: pass it to `useWebContainer({ previewScript })`. The preview is
 * cross-origin, so the page around it cannot read its address or its history. This script sends the page address to
 * `WorkspacePreview` through a `MessagePort`, and goes Back, Forward, or reloads when the preview asks. A page that runs
 * in its own tab does nothing.
 */
export const workspacePreviewScript = `(() => {
  if (window.top === window) return;
  const { port1: port, port2 } = new MessageChannel();
  const navigation = window.navigation;
  const report = () => port.postMessage({
    type: "location",
    path: location.pathname + location.search + location.hash,
    back: navigation ? navigation.canGoBack : true,
    forward: navigation ? navigation.canGoForward : true,
  });
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      report();
      return result;
    };
  }
  addEventListener("popstate", report);
  addEventListener("hashchange", report);
  port.onmessage = ({ data }) => {
    if (data === "back") history.back();
    else if (data === "forward") history.forward();
    else if (data === "reload") location.reload();
  };
  window.top.postMessage({ type: "vitehub:preview" }, "*", [port2]);
  report();
})();`;

/** Where the preview page is, as `workspacePreviewScript` reports it. */
interface PreviewLocation {
  path: string;
  back: boolean;
  forward: boolean;
}

function readLocation(data: unknown): PreviewLocation | undefined {
  if (!data || typeof data !== "object") return undefined;
  const { type, path, back, forward } = data as Record<string, unknown>;
  if (type !== "location" || typeof path !== "string") return undefined;
  return { path, back: back === true, forward: forward === true };
}

/** Whether `source` is `frame` or a frame inside it. The preview origin wraps the app in frames of its own. */
function isInside(source: MessageEventSource | null, frame: Window | null | undefined): boolean {
  let current: unknown = source;
  for (let depth = 0; frame && current && typeof current === "object" && depth < 8; depth++) {
    if (current === frame) return true;
    // A cross-origin window exposes `parent`. The top window is its own parent.
    const parent: unknown = Reflect.get(current, "parent");
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/** The widths that the device switch offers. Desktop fills the pane. */
export type WorkspacePreviewDevice = "desktop" | "tablet" | "phone";

const devices: { id: WorkspacePreviewDevice, label: string, icon: WorkspaceIconName }[] = [
  { id: "desktop", label: "Desktop", icon: "monitor" },
  { id: "tablet", label: "Tablet", icon: "tablet" },
  { id: "phone", label: "Phone", icon: "smartphone" },
];
// Chrome's Tablet breakpoint and a common phone, in CSS pixels.
const presets: readonly DeviceFramePreset[] = [
  { id: "tablet", label: "Tablet", kind: "tablet", width: 768, height: 1024 },
  { id: "phone", label: "Phone", kind: "phone", width: 390, height: 844 },
];
const storageKey = "vitehub:workspace-preview:device";

function sizeOf(device: WorkspacePreviewDevice): DeviceFrameSize {
  const preset = presets.find(item => item.id === device) ?? presets[0]!;
  return { on: device !== "desktop", id: preset.id, width: preset.width, height: preset.height, zoom: null };
}

function storedDevice(): WorkspacePreviewDevice {
  if (typeof localStorage === "undefined") return "desktop";
  try {
    const value = localStorage.getItem(storageKey);
    return devices.find(item => item.id === value)?.id ?? "desktop";
  }
  catch {
    return "desktop";
  }
}

/**
 * The preview of the dev server, in a browser frame: Back, Forward, Reload, the address of the page, a device width
 * switch, and Open in new tab. The page cannot `fetch()` the WebContainer preview origin, so an iframe is the only way
 * to show it. Back, Forward, and an address that follows links in the app need `workspacePreviewScript` in the
 * WebContainer. Without it, the bar shows the path that it opened.
 */
export const WorkspacePreview = defineComponent({
  name: "WorkspacePreview",
  props: {
    /** The preview URL, such as `workspace.previewUrl`. Unset until the dev server is ready. */
    url: { default: undefined, type: String },
    /** The path that the frame opens. Use `v-model:path`. */
    path: { default: "/", type: String },
    title: { default: "App preview", type: String },
    /** The width of the page. Use `v-model:device`. Defaults to the last width that the reader picked. */
    device: { default: undefined, type: String as PropType<WorkspacePreviewDevice> },
  },
  emits: {
    "update:path": (path: string) => typeof path === "string",
    "update:device": (device: WorkspacePreviewDevice) => typeof device === "string",
  },
  setup(props, { emit, expose, slots }) {
    const inputId = useId();
    const UInput = useUIComponent("UInput");
    const reloads = ref(0);
    const src = computed(() => props.url ? join(props.url, props.path) : undefined);

    // The page that the frame shows, while the preview script reports it. A new frame starts without it.
    const live = shallowRef<PreviewLocation>();
    const port = shallowRef<MessagePort>();
    const frame = ref<HTMLIFrameElement>();
    const current = computed(() => live.value?.path ?? props.path);
    const draft = ref(current.value);
    watch(current, (path) => { draft.value = path; });
    watch(() => `${src.value}#${reloads.value}`, () => {
      live.value = undefined;
      port.value?.close();
      port.value = undefined;
    });

    function onMessage(event: MessageEvent) {
      const data: unknown = event.data;
      if (!data || typeof data !== "object" || Reflect.get(data, "type") !== "vitehub:preview") return;
      const next = event.ports[0];
      if (!next || !isInside(event.source, frame.value?.contentWindow)) return;
      port.value?.close();
      port.value = next;
      next.onmessage = (message) => {
        const location = readLocation(message.data);
        if (location) live.value = location;
      };
    }
    onMounted(() => window.addEventListener("message", onMessage));
    onBeforeUnmount(() => {
      window.removeEventListener("message", onMessage);
      port.value?.close();
    });

    function go() {
      const path = draft.value.startsWith("/") ? draft.value : `/${draft.value}`;
      draft.value = path;
      if (path === props.path) reloads.value++;
      else emit("update:path", path);
    }
    // Reload the page where it is. Without the script, mount a new frame: the page cannot reach into the cross-origin frame.
    function reload() {
      if (port.value) port.value.postMessage("reload");
      else reloads.value++;
    }
    const step = (direction: "back" | "forward") => port.value?.postMessage(direction);
    expose({ reload });

    const picked = ref<WorkspacePreviewDevice>(props.device ?? storedDevice());
    // DeviceFrame takes any size: a drag on its edge changes it, and the switch sets it back to a device.
    const size = ref<DeviceFrameSize>(sizeOf(picked.value));
    function show(device: WorkspacePreviewDevice) {
      picked.value = device;
      size.value = sizeOf(device);
    }
    watch(() => props.device, (device) => { if (device && device !== picked.value) show(device); });
    function pick(device: WorkspacePreviewDevice) {
      show(device);
      try {
        localStorage.setItem(storageKey, device);
      }
      catch {
        // Storage can be full or blocked; the switch keeps working without it.
      }
      emit("update:device", device);
    }

    const button = (name: WorkspaceIconName, label: string, title: string, disabled: boolean, onClick: () => void) =>
      h("button", { "aria-label": label, class: "vh-ws-icon-button", disabled, title, type: "button", onClick }, [icon(name)]);

    return () => {
      const connected = !!port.value && !!src.value;
      return h("div", { class: "vh-ws-preview", "data-device": picked.value }, [
        h("form", {
          class: "vh-ws-preview-bar",
          onSubmit(event: Event) {
            event.preventDefault();
            go();
          },
        }, [
          button("arrow-left", "Go back", "Back", !connected || !live.value?.back, () => step("back")),
          button("arrow-right", "Go forward", "Forward", !connected || !live.value?.forward, () => step("forward")),
          button("rotate-cw", "Reload preview", "Reload", !src.value, reload),
          h("label", { class: "vh-ws-sr-only", for: inputId }, "Preview path"),
          h(UInput, {
            autocapitalize: "off",
            autocomplete: "off",
            class: "vh-ws-preview-path",
            disabled: !src.value,
            id: inputId,
            modelValue: draft.value,
            spellcheck: false,
            "onUpdate:modelValue": (value: string | number) => { draft.value = String(value); },
          }),
          h("div", { "aria-label": "Device width", class: "vh-ws-preview-devices", role: "group" }, devices.map(device =>
            h("button", {
              "aria-label": device.label,
              "aria-pressed": picked.value === device.id ? "true" : "false",
              class: "vh-ws-icon-button",
              key: device.id,
              title: device.id === "desktop" ? device.label : `${device.label}, ${sizeOf(device.id).width} pixels wide`,
              type: "button",
              onClick: () => pick(device.id),
            }, [icon(device.icon)]))),
          h("a", {
            "aria-disabled": src.value ? undefined : "true",
            "aria-label": "Open preview in a new tab",
            class: "vh-ws-icon-button",
            href: props.url ? join(props.url, current.value) : undefined,
            rel: "noopener",
            target: "_blank",
            title: "Open in new tab",
          }, [icon("external-link")]),
        ]),
        src.value
          ? h(DeviceFrame, {
              breakpoints: [],
              insetBottom: 16,
              modelValue: size.value,
              presets,
              toolbar: false,
              "onUpdate:modelValue": (next: DeviceFrameSize) => { size.value = next; },
            }, () => h("iframe", {
              // Reload by mounting a new frame when the preview script is not there.
              allow: "cross-origin-isolated; clipboard-read; clipboard-write",
              class: "vh-ws-preview-frame",
              key: `${src.value}#${reloads.value}`,
              ref: frame,
              src: src.value,
              title: props.title,
            }))
          : h("div", { class: "vh-ws-empty" }, slots.empty?.() ?? [
              h("p", { class: "vh-ws-empty-title" }, "No preview yet"),
              h("p", { class: "vh-ws-muted" }, "The preview opens here when the dev server is ready."),
            ]),
      ]);
    };
  },
});
