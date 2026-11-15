// After Chrome's device toolbar and Firefox's responsive mode, as Drop's device mode first built it: one bar above the
// page picks a device, takes any width and height, rotates, sets the width to one of Chrome's breakpoints in a click, and
// zooms. The page gets exactly that many CSS pixels, so its media queries see a phone. It sits centered on a muted stage
// and fits the pane, scaled down but never up, as in T3 Code's preview. Its right, bottom and corner edges drag to any
// size. Off, the page fills the frame. The same elements render either way, so an iframe inside never reloads.
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, watch, type PropType, type VNode } from "vue";

/** A device the bar offers, in CSS pixels, the way it usually stands. */
export interface DeviceFramePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  /** The icon the bar shows for it. */
  kind?: "phone" | "tablet" | "laptop" | "desktop";
}

/** A width the bar offers as a one-click box, such as Chrome's "Tablet" at 768. */
export interface DeviceFrameBreakpoint {
  label: string;
  width: number;
}

/**
 * Device mode's state: whether it is on, the size (a preset's id, or `custom` for a size typed or dragged), and the
 * zoom, a fraction, or `null` to fit the pane.
 */
export interface DeviceFrameSize {
  on: boolean;
  id: string;
  width: number;
  height: number;
  zoom: number | null;
}

export const DEVICE_FRAME_PRESETS: readonly DeviceFramePreset[] = [
  { id: "iphone", label: "iPhone", kind: "phone", width: 393, height: 852 },
  { id: "ipad", label: "iPad", kind: "tablet", width: 820, height: 1180 },
  { id: "laptop", label: "Laptop", kind: "laptop", width: 1280, height: 800 },
  { id: "desktop", label: "Desktop", kind: "desktop", width: 1920, height: 1080 },
];

/** The widths Chrome's device mode marks above the page, narrowest first. */
export const DEVICE_FRAME_BREAKPOINTS: readonly DeviceFrameBreakpoint[] = [
  { label: "Mobile S", width: 320 },
  { label: "Mobile M", width: 375 },
  { label: "Mobile L", width: 425 },
  { label: "Tablet", width: 768 },
  { label: "Laptop", width: 1024 },
  { label: "Laptop L", width: 1440 },
  { label: "4K", width: 2560 },
];

// Chrome's device mode and T3 Code's preview take the same bounds.
const SIZE_MIN = 240;
const SIZE_MAX = 3840;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const clampSize = (value: number) => Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, value)));
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));

// Lucide icons (ISC), inlined so the frame needs nothing but Vue.
const paths: Record<string, string[]> = {
  phone: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z", "M12 18h.01"],
  tablet: ["M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z", "M12 18h.01"],
  laptop: ["M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"],
  desktop: ["M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M8 21h8", "M12 17v4"],
  custom: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M3 9h18", "M9 21V9"],
  rotate: ["M20 9V7a2 2 0 0 0-2-2h-6", "m15 2-3 3 3 3", "M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"],
  chevron: ["m6 9 6 6 6-6"],
  close: ["M18 6 6 18", "m6 6 12 12"],
};
function icon(name: string, className = "vh-device-frame__icon"): VNode {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      class: className,
      fill: "none",
      stroke: "currentColor",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-width": "1.75",
      viewBox: "0 0 24 24",
    },
    (paths[name] ?? []).map((d) => h("path", { d })),
  );
}

function readStored(key: string | undefined): DeviceFrameSize | undefined {
  if (!key || typeof localStorage === "undefined") return undefined;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return undefined;
    const { on, id, width, height, zoom } = value as Record<string, unknown>;
    if (typeof width !== "number" || typeof height !== "number" || typeof id !== "string") return undefined;
    return { on: on === true, id, width: clampSize(width), height: clampSize(height), zoom: typeof zoom === "number" ? clampZoom(zoom) : null };
  }
  catch {
    return undefined;
  }
}

/** Shows its content at a device's size: a bar with the device, the size, Rotate, breakpoints and zoom, over a stage that fits the pane. */
export const DeviceFrame = defineComponent({
  name: "DeviceFrame",
  props: {
    /** The size, for `v-model`. Without it the frame keeps its own state. */
    modelValue: { default: undefined, type: Object as PropType<DeviceFrameSize> },
    /** The first size when uncontrolled and nothing is stored. */
    defaultValue: { default: undefined, type: Object as PropType<Partial<DeviceFrameSize>> },
    /** Keeps the uncontrolled size in local storage under this key. */
    storageKey: { default: undefined, type: String },
    /** The devices the bar offers. Defaults to `DEVICE_FRAME_PRESETS`: iPhone, iPad, Laptop, and Desktop. */
    presets: { default: undefined, type: Array as PropType<readonly DeviceFramePreset[]> },
    /** The one-click widths. Defaults to `DEVICE_FRAME_BREAKPOINTS`, Chrome's; pass `[]` to hide them. */
    breakpoints: { default: undefined, type: Array as PropType<readonly DeviceFrameBreakpoint[]> },
    /** Shows the content full size without the bar, and keeps the size for later. */
    disabled: { default: false, type: Boolean },
    /** Shows the bar above the page while device mode is on. Pass `false` when the page around the frame has its own device controls. */
    toolbar: { default: true, type: Boolean },
    /** Space in pixels under the page, for a toolbar that floats over the bottom of the frame. */
    insetBottom: { default: 16, type: Number },
  },
  emits: {
    "update:modelValue": (_size: DeviceFrameSize) => true,
  },
  setup(props, { emit, slots, expose }) {
    const presets = computed(() => props.presets ?? DEVICE_FRAME_PRESETS);
    const breakpoints = computed(() => props.breakpoints ?? DEVICE_FRAME_BREAKPOINTS);
    const first = presets.value[0] ?? DEVICE_FRAME_PRESETS[0]!;
    const initial = (): DeviceFrameSize => ({
      on: false,
      id: first.id,
      width: first.width,
      height: first.height,
      zoom: null,
      ...(readStored(props.storageKey) ?? props.defaultValue),
    });
    const local = ref<DeviceFrameSize>(initial());
    const size = computed(() => props.modelValue ?? local.value);
    function update(next: Partial<DeviceFrameSize>) {
      const value = { ...size.value, ...next };
      if (props.modelValue === undefined) {
        local.value = value;
        if (props.storageKey && typeof localStorage !== "undefined") {
          try {
            localStorage.setItem(props.storageKey, JSON.stringify(value));
          }
          catch {
            // Storage can be full or blocked; the frame keeps working without it.
          }
        }
      }
      emit("update:modelValue", value);
    }

    const sized = computed(() => !props.disabled && size.value.on);
    const presetOf = (id: string) => presets.value.find((item) => item.id === id);
    const matching = (width: number, height: number) =>
      presets.value.find((item) => (item.width === width && item.height === height) || (item.width === height && item.height === width))?.id ?? "custom";
    const preset = computed(() => presetOf(size.value.id));
    const setSize = (width: number, height: number) => update({ on: true, width, height, id: matching(width, height) });

    function pick(id: string) {
      const next = presetOf(id);
      if (!next) return;
      // A device keeps the way it was turned.
      const current = preset.value;
      const turned = current && size.value.width === current.height && size.value.width !== current.width;
      update(turned ? { id, width: next.height, height: next.width } : { id, width: next.width, height: next.height });
    }
    const rotate = () => update({ width: size.value.height, height: size.value.width });
    const within = computed(() => breakpoints.value.filter((band) => band.width <= size.value.width).at(-1)?.width);

    // The stage's content box is the room the page fits into.
    const stage = ref<HTMLElement>();
    const room = ref({ width: 0, height: 0 });
    let observer: ResizeObserver | undefined;
    onMounted(() => {
      if (!stage.value || typeof ResizeObserver === "undefined") return;
      observer = new ResizeObserver(([entry]) => {
        if (entry) room.value = { width: entry.contentRect.width, height: entry.contentRect.height };
      });
      observer.observe(stage.value);
    });
    onBeforeUnmount(() => observer?.disconnect());
    const fit = computed(() =>
      room.value.width && room.value.height ? Math.min(1, room.value.width / size.value.width, room.value.height / size.value.height) : 1,
    );
    // Frozen while dragging, so the edge stays under the pointer.
    const held = ref<number | null>(null);
    const scale = computed(() => Math.max(ZOOM_MIN, held.value ?? size.value.zoom ?? fit.value));

    let start: { x: number; y: number; width: number; height: number } | undefined;
    function grab(event: PointerEvent) {
      if (event.currentTarget instanceof Element) event.currentTarget.setPointerCapture(event.pointerId);
      start = { x: event.clientX, y: event.clientY, width: size.value.width, height: size.value.height };
      held.value = scale.value;
    }
    // The page is centered, so its right edge moves half as far as its width grows.
    function drag(event: PointerEvent, edges: { x?: boolean; y?: boolean }) {
      if (!start) return;
      const s = scale.value;
      setSize(
        edges.x ? clampSize(start.width + (2 * (event.clientX - start.x)) / s) : size.value.width,
        edges.y ? clampSize(start.height + (event.clientY - start.y) / s) : size.value.height,
      );
    }
    function release() {
      start = undefined;
      held.value = null;
    }
    // Arrow keys resize from a focused edge: 10 pixels, 50 with Shift.
    function nudge(event: KeyboardEvent, edges: { x?: boolean; y?: boolean }) {
      const step = event.shiftKey ? 50 : 10;
      const dx = edges.x ? (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0) : 0;
      const dy = edges.y ? (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) : 0;
      if (!dx && !dy) return;
      event.preventDefault();
      setSize(clampSize(size.value.width + dx), clampSize(size.value.height + dy));
    }

    // An empty or half-typed field reads as NaN, and the size stays as it was.
    const numberValue = (event: Event) => (event.target instanceof HTMLInputElement ? event.target.valueAsNumber : Number.NaN);
    expose({ rotate, fit: () => update({ zoom: null }) });

    function toolbar(): VNode {
      const current = size.value;
      const percent = Math.round(scale.value * 100);
      return h("div", { key: "bar", class: "vh-device-frame__bar", role: "toolbar", "aria-label": "Device" }, [
        slots["toolbar-start"]?.(),
        h("label", { class: "vh-device-frame__select", "data-focus-ring": "" }, [
          icon(preset.value?.kind ?? "custom"),
          h("span", { "aria-hidden": "true", class: "vh-device-frame__select-label" }, preset.value?.label ?? "Custom"),
          h(
            "select",
            { "aria-label": "Device", value: preset.value ? current.id : "custom", onChange: (event: Event) => event.target instanceof HTMLSelectElement && pick(event.target.value) },
            [
              ...presets.value.map((item) => h("option", { key: item.id, value: item.id }, `${item.label} · ${item.width} × ${item.height}`)),
              preset.value ? null : h("option", { value: "custom", disabled: true }, "Custom"),
            ],
          ),
          icon("chevron", "vh-device-frame__chevron"),
        ]),
        h("input", {
          "aria-label": "Width",
          class: "vh-device-frame__number",
          "data-focus-frame": "",
          inputmode: "numeric",
          max: SIZE_MAX,
          min: SIZE_MIN,
          type: "number",
          value: current.width,
          onChange: (event: Event) => { const value = numberValue(event); if (Number.isFinite(value)) setSize(clampSize(value), current.height); },
        }),
        h("span", { "aria-hidden": "true", class: "vh-device-frame__times" }, "×"),
        h("input", {
          "aria-label": "Height",
          class: "vh-device-frame__number",
          "data-focus-frame": "",
          inputmode: "numeric",
          max: SIZE_MAX,
          min: SIZE_MIN,
          type: "number",
          value: current.height,
          onChange: (event: Event) => { const value = numberValue(event); if (Number.isFinite(value)) setSize(current.width, clampSize(value)); },
        }),
        h("button", { class: "vh-device-frame__button", type: "button", onClick: rotate }, [icon("rotate"), h("span", "Rotate")]),
        breakpoints.value.length
          ? h("div", { class: "vh-device-frame__bands", role: "group", "aria-label": "Breakpoints" }, breakpoints.value.map((band) =>
              h(
                "button",
                {
                  key: band.width,
                  "aria-label": `${band.label}, ${band.width} pixels wide`,
                  "aria-pressed": current.width === band.width ? "true" : "false",
                  class: "vh-device-frame__band",
                  "data-within": within.value === band.width ? "" : undefined,
                  title: band.label,
                  type: "button",
                  onClick: () => setSize(band.width, current.height),
                },
                String(band.width),
              )))
          : null,
        h("div", { class: "vh-device-frame__end" }, [
          h("label", { class: "vh-device-frame__zoom" }, [
            h("input", {
              "aria-label": "Zoom, in percent",
              class: "vh-device-frame__number",
              "data-focus-frame": "",
              inputmode: "numeric",
              max: ZOOM_MAX * 100,
              min: ZOOM_MIN * 100,
              step: 10,
              type: "number",
              value: percent,
              onChange: (event: Event) => { const value = numberValue(event); if (Number.isFinite(value) && value > 0) update({ zoom: clampZoom(value / 100) }); },
            }),
            h("span", { "aria-hidden": "true" }, "%"),
          ]),
          h("button", {
            "aria-pressed": current.zoom === null ? "true" : "false",
            class: "vh-device-frame__button",
            type: "button",
            onClick: () => update({ zoom: null }),
          }, "Fit"),
          slots["toolbar-end"]?.(),
          h("button", {
            "aria-label": "Leave device mode",
            class: "vh-device-frame__button vh-device-frame__icon-button",
            title: "Leave device mode",
            type: "button",
            onClick: () => update({ on: false }),
          }, [icon("close")]),
        ]),
      ]);
    }

    const HANDLES = [
      { edge: "x", edges: { x: true }, label: "Drag to change the width" },
      { edge: "y", edges: { y: true }, label: "Drag to change the height" },
      { edge: "xy", edges: { x: true, y: true }, label: "Drag to resize" },
    ] as const;

    watch(() => props.storageKey, () => {
      if (props.modelValue === undefined) local.value = initial();
    });

    return () => {
      const on = sized.value;
      const current = size.value;
      const s = scale.value;
      return h("div", { class: "vh-device-frame", "data-slot": "device-frame", "data-on": on ? "" : undefined, "data-dragging": held.value === null ? undefined : "" }, [
        on && props.toolbar ? toolbar() : null,
        h("div", {
          key: "stage",
          ref: stage,
          class: "vh-device-frame__stage",
          style: on ? { paddingBottom: `${props.insetBottom}px` } : undefined,
        }, [
          // The scaled page's footprint; the page inside keeps its real size.
          h("div", { class: "vh-device-frame__footprint", style: on ? { width: `${current.width * s}px`, height: `${current.height * s}px` } : undefined }, [
            h("div", {
              class: "vh-device-frame__page",
              style: on ? { width: `${current.width}px`, height: `${current.height}px`, transform: `scale(${s})` } : undefined,
            }, slots.default?.()),
            on && held.value !== null ? h("p", { class: "vh-device-frame__readout", "aria-live": "polite" }, `${current.width} × ${current.height}`) : null,
            ...(on
              ? HANDLES.map((handle) =>
                  h("div", {
                    key: handle.edge,
                    "aria-label": handle.label,
                    "aria-orientation": handle.edge === "y" ? "horizontal" : "vertical",
                    "aria-valuenow": handle.edge === "y" ? current.height : current.width,
                    "aria-valuemin": SIZE_MIN,
                    "aria-valuemax": SIZE_MAX,
                    class: "vh-device-frame__handle",
                    "data-edge": handle.edge,
                    role: "separator",
                    tabindex: 0,
                    onKeydown: (event: KeyboardEvent) => nudge(event, handle.edges),
                    onLostpointercapture: release,
                    onPointerdown: grab,
                    onPointermove: (event: PointerEvent) => drag(event, handle.edges),
                  }, handle.edge === "xy" ? undefined : [h("span", { class: "vh-device-frame__grip" })]))
              : []),
          ]),
        ]),
      ]);
    };
  },
});
