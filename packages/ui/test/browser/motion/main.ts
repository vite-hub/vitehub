// The motion page: every role that the motion layer of `@vite-hub/ui/motion` moves, with Nuxt UI components and with
// plain elements. `?mode=today` turns the layer off and gives UButton the press of the theme before the layer, to record
// both. The bar on top sets the speed (1×, ¼×) and reduced motion. Each later effect adds its role here.
import { addCollection } from "@iconify/vue";
import lucide from "@iconify-json/lucide/icons.json";
import "@fontsource-variable/geist";
import UButton from "@nuxt/ui/components/Button.vue";
import UCheckbox from "@nuxt/ui/components/Checkbox.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import URadioGroup from "@nuxt/ui/components/RadioGroup.vue";
import USlider from "@nuxt/ui/components/Slider.vue";
import USplitter from "@nuxt/ui/components/Splitter.vue";
import USwitch from "@nuxt/ui/components/Switch.vue";
import UTabs from "@nuxt/ui/components/Tabs.vue";
import { Slider as SdkSlider, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from "@ui-sdk/vue/slider";
import { createApp, h, ref } from "vue";
import type { VNode } from "vue";

import { createViteHubUI } from "../../../src/config.ts";
import { defineMotionEffect, forceReducedMotion, getMotionSlowFactor, prefersReducedMotion, setMotionSlowFactor } from "../../../src/motion.ts";
import "./styles.css";
import { textRows } from "./text.ts";
import { togetherRows } from "./together.ts";

const today = new URLSearchParams(location.search).get("mode") === "today";
const inverted = new URLSearchParams(location.search).has("inverted");
const pressMode = new URLSearchParams(location.search).get("press");
// The press of `vitehubTheme.button` before the motion layer.
const todayPress = "transition-[color,background-color,box-shadow,transform] duration-150 ease-out motion-safe:active:not-disabled:scale-[.97]";
const buttonClass = today ? todayPress : undefined;
// The thumb of USwitch before the motion layer: a CSS transition on its translate, and one size.
const todayThumb = "transition-transform duration-200 ease-out data-[state=unchecked]:scale-100";
const switchUI = today ? { thumb: todayThumb } : undefined;
// The UTabs indicator transition of Nuxt UI's theme before the motion layer.
const todayIndicator = "transition-[translate,width] duration-200 ease-out";

if (new URLSearchParams(location.search).has("override")) {
  const remove = defineMotionEffect({
    name: "press",
    selector: "[data-test=button]",
    press(element) {
      element.dataset.customPress = "true";
    },
  });
  Object.assign(window, { removePressOverride: remove });
}
Object.assign(window, { forceReducedMotion });

addCollection(lucide);

const slow = ref(getMotionSlowFactor());
const reduced = ref(prefersReducedMotion());
const tab = ref("overview");
const on = ref(false);
const checked = ref(false);
const plan = ref("free");
const live = ref(false);
const mixed = ref<boolean | "indeterminate">("indeterminate");
const plainOn = ref(false);
const saved = ref(false);
const starred = ref(false);
const pinned = ref(false);
const cssSaved = ref(false);
const inlineSaved = ref(false);
const bold = ref(false);
const view = ref("grid");
const offOn = ref(false);
const offChecked = ref(false);
const offSaved = ref(false);
const plainTab = ref("Overview");
const segment = ref("Preview");
const offTab = ref("One");
const hovered = ref<string | null>(null);

const plainRoles = ["button", "link", "tab", "radio", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "switch", "checkbox"];

// A plain group with no indicator, keyboard included: the selected item draws its own look, and the select effect
// moves a copy of it.
function plainGroup(testId: string, role: "tablist" | "radiogroup", items: string[], model: { value: string }): VNode {
  const itemRole = role === "tablist" ? "tab" : "radio";
  const attribute = role === "tablist" ? "aria-selected" : "aria-checked";
  const pick = (item: string, focus = false) => {
    model.value = item;
    if (focus) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-test=${testId}] [data-item="${item}"]`)?.focus());
  };
  return h("div", { "class": "plain-group", role, "aria-label": testId, "data-test": testId, "onKeydown": (event: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    pick(items[(items.indexOf(model.value) + step + items.length) % items.length]!, true);
  } }, items.map(item => h("button", { "type": "button", "role": itemRole, "data-item": item, [attribute]: String(model.value === item), "tabindex": model.value === item ? 0 : -1, "onClick": () => pick(item) }, item)));
}

function row(title: string, children: VNode[]): VNode {
  return h("section", { class: "row" }, [h("h2", title), ...children]);
}

// A button inside a shadow root, as the page pill and the comments overlay render theirs.
class ShadowButton extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>button { height: 32px; padding: 0 12px; border: 1px solid currentColor; border-radius: 6px; background: none; font: 500 12px sans-serif; }</style><button data-test="shadow">In a shadow root</button>`;
  }
}
customElements.define("motion-shadow-button", ShadowButton);

const volume = ref(40);
const interval = ref([20, 80]);
const sdkVolume = ref(40);
const plainVolume = ref(40);
const filesWidth = ref(150);

function setPlainVolume(value: number): void {
  plainVolume.value = Math.round(Math.max(0, Math.min(100, value)));
}

function at(event: PointerEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  setPlainVolume((event.clientX - rect.left) / rect.width * 100);
}

function plainSlider(): VNode {
  return h("div", {
    "class": "plain-slider",
    "data-test": "plain-slider",
    onPointerdown(event: PointerEvent) {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      at(event);
    },
    onPointermove(event: PointerEvent) {
      if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) at(event);
    },
  }, [
    h("div", { "class": "plain-slider-range", "data-slot": "range", "style": { width: `${plainVolume.value}%` } }),
    h("div", {
      "class": "plain-slider-thumb",
      "role": "slider",
      "tabindex": 0,
      "aria-label": "Plain volume",
      "aria-valuemin": 0,
      "aria-valuemax": 100,
      "aria-valuenow": plainVolume.value,
      "style": { left: `${plainVolume.value}%` },
      onKeydown(event: KeyboardEvent) {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        setPlainVolume(plainVolume.value + step * (event.shiftKey ? 10 : 1));
      },
    }),
  ]);
}

let start: { x: number; width: number } | undefined;

function plainPanels(): VNode {
  return h("div", { "class": "plain-panels", "data-test": "panels" }, [
    h("div", { "class": "plain-pane", "data-test": "files", "style": { width: `${filesWidth.value}px` } }, "Files"),
    h("div", {
      "class": "plain-edge",
      "data-test": "resize",
      "role": "separator",
      "tabindex": 0,
      "aria-label": "Resize files",
      "aria-orientation": "vertical",
      "aria-valuenow": filesWidth.value,
      "aria-valuemin": 120,
      "aria-valuemax": 220,
      onPointerdown(event: PointerEvent) {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        start = { x: event.clientX, width: filesWidth.value };
      },
      onPointermove(event: PointerEvent) {
        if (!start) return;
        filesWidth.value = Math.max(120, Math.min(220, start.width + event.clientX - start.x));
      },
      onPointerup() {
        start = undefined;
      },
    }),
    h("div", { class: "plain-pane plain-pane-main" }, "Document"),
  ]);
}

function dragRows(): VNode[] {
  const line = () => h("span", { class: "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-(--ui-border) group-hover:bg-(--ui-border-accented)" });
  return [
    row("USlider, ui-sdk slider, plain slider", [
      h(USlider, { "data-test": "slider", "class": "w-80", "aria-label": "Volume", inverted, "modelValue": volume.value, "onUpdate:modelValue": (value: number | number[] | undefined) => (volume.value = Number(value)) }),
      h(SdkSlider, { "data-test": "sdk-slider", "class": "sdk-slider", "modelValue": sdkVolume.value, "onUpdate:modelValue": (value: number | number[]) => (sdkVolume.value = Number(value)) }, () => [
        h(SliderControl, { class: "sdk-slider-control" }, () => [
          h(SliderTrack, { class: "sdk-slider-track" }, () => [
            h(SliderIndicator, { class: "sdk-slider-range" }),
            h(SliderThumb, { "class": "sdk-slider-thumb", "aria-label": "Kit volume" }),
          ]),
        ]),
      ]),
      plainSlider(),
      ...(inverted ? [
        h(USlider, { "data-test": "interval", "class": "w-80", "aria-label": "Interval", "modelValue": interval.value }),
        h("button", { "data-test": "set-interval", "onClick": () => (interval.value = [35, 65]) }, "Set interval"),
      ] : []),
    ]),
    row("USplitter, a plain resize handle", [
      h("div", { class: "splitter-frame" }, [
        h(USplitter, { "data-test": "splitter", "items": [{ id: "files", slot: "files", defaultSize: 30, minSize: 20, maxSize: 40 }, { id: "doc", slot: "doc", defaultSize: 70 }] }, {
          "files": () => h("div", { class: "plain-pane" }, "Files"),
          "doc": () => h("div", { class: "plain-pane plain-pane-main" }, "Document"),
          "resize-handle": line,
        }),
      ]),
      plainPanels(),
    ]),
  ];
}

const app = createApp({
  render: () => h("main", { class: "page" }, [
    row("Speed and reduced motion", [
      h(UButton, { "data-test": "speed", variant: "outline", label: slow.value === 1 ? "1×" : "¼×", onClick: () => {
        slow.value = slow.value === 1 ? 4 : 1;
        setMotionSlowFactor(slow.value);
      } }),
      h(UButton, { "data-test": "reduce", variant: "outline", "aria-pressed": reduced.value, label: reduced.value ? "Reduced motion on" : "Reduced motion off", onClick: () => {
        reduced.value = !reduced.value;
        forceReducedMotion(reduced.value);
      } }),
    ]),
    row("UButton", [
      h(UButton, { "data-test": "button", label: "Publish", class: buttonClass }),
      h(UButton, { "data-test": "button-outline", variant: "outline", label: "Duplicate", class: buttonClass }),
      h(UButton, { "data-test": "button-large", size: "lg", label: "Deploy", class: buttonClass }),
      h(UButton, { "data-test": "button-icon", variant: "ghost", icon: "i-lucide-trash-2", "aria-label": "Delete", class: buttonClass }),
      h(UButton, { "data-test": "button-disabled", label: "Disabled", disabled: true, class: buttonClass }),
      h(UButton, { "data-test": "button-link", to: "#link", variant: "link", label: "A link", class: buttonClass }),
    ]),
    row("UTabs", [
      h(UTabs, { "data-test": "tabs", "ui": today ? { indicator: todayIndicator } : undefined, "modelValue": tab.value, "onUpdate:modelValue": (value: string | number) => (tab.value = String(value)), content: false, items: [{ label: "Overview", value: "overview" }, { label: "Logs", value: "logs" }, { label: "Settings", value: "settings" }] }),
    ]),
    row("USwitch, UCheckbox, URadioGroup", [
      h(USwitch, { "data-test": "switch", "modelValue": on.value, "onUpdate:modelValue": (value: boolean) => (on.value = value), label: "Live", ui: switchUI }),
      h(UCheckbox, { "data-test": "checkbox", "modelValue": checked.value, "onUpdate:modelValue": (value: boolean | "indeterminate") => (checked.value = value === true), label: "Notify me" }),
      h(URadioGroup, { "data-test": "radio", "modelValue": plan.value, "onUpdate:modelValue": (value: string) => (plan.value = value), orientation: "horizontal", items: [{ label: "Free", value: "free" }, { label: "Pro", value: "pro" }] }),
    ]),
    row("Select one of many", [
      plainGroup("plain-tabs", "tablist", ["Overview", "Deployments", "Logs"], plainTab),
      plainGroup("plain-segment", "radiogroup", ["Preview", "Code"], segment),
      h("div", { "data-motion": "none" }, [plainGroup("select-off", "tablist", ["One", "Two"], offTab)]),
      h("ul", { "class": "hover-grid", "data-motion-select": "", "data-test": "hover-grid", "onPointerleave": () => (hovered.value = null) }, ["Blob", "Queue", "Agent"].map(name =>
        h("li", { "data-item": name, "data-state": hovered.value === name ? "active" : undefined, "onPointerenter": () => (hovered.value = name) }, [
          hovered.value === name ? h("span", { "class": "hover-mark", "data-motion-indicator": "", "aria-hidden": "true" }) : null,
          name,
        ]))),
    ]),
    row("Plain elements by role", [
      h("button", { "class": "plain", "data-test": "plain-button" }, "button"),
      h("a", { "class": "plain", "href": "#a", "data-test": "plain-a" }, "a[href]"),
      h("p", ["Read the ", h("a", { "href": "#inline", "data-test": "inline-a" }, "inline link"), "."]),
      h("details", [h("summary", { "class": "plain", "data-test": "plain-summary" }, "summary")]),
      ...plainRoles.map(role => h("div", { "class": "plain", role, "tabindex": 0, "data-test": `role-${role}` }, `role=${role}`)),
    ]),
    row("No motion", [
      h("button", { "class": "plain", "disabled": true, "data-test": "plain-disabled" }, "disabled"),
      h("div", { "class": "plain", "role": "button", "aria-disabled": "true", "tabindex": 0, "data-test": "aria-disabled" }, "aria-disabled"),
      h("div", { "data-motion": "none" }, [h("button", { "class": "plain", "data-test": "opt-out" }, "opted out")]),
      h("button", { "class": "plain own-press", "data-test": "own-press" }, "own scale"),
      h("button", { "class": "plain", "data-test": "not-a-control-parent" }, [h("span", { "data-test": "inner-span" }, "a span")]),
    ]),
    row("Press scope", [
      h("button", { "class": "plain", "data-test": "wide-button", "style": { width: "300px" } }, "A wide button"),
      h("p", { "class": "plain", "role": "button", "tabindex": 0, "data-test": "row-button" }, "A row"),
      h("a", { "class": "plain", "href": "#block", "data-test": "block-link", "style": { display: "flex" } }, "A block link"),
      h("a", { "class": "plain", "href": "#opted", "data-motion-press": "", "data-test": "opt-link" }, "Opted in"),
      h("a", { "class": "plain", "href": "#icon", "data-motion-press": "icon", "data-test": "opt-icon" }, [h(UIcon, { name: "i-lucide-arrow-right" }), "Next"]),
      h("div", { "class": "row", "data-motion-press": "none" }, [
        h("div", { "data-motion-press": "" }, [
          h("button", { "class": "plain", "data-test": "none-button" }, "No press"),
        ]),
        h("button", { "class": "plain", "data-motion-press": "", "data-test": "none-own" }, "Own"),
      ]),
      h("div", { "class": "plain", "data-motion-press": "", "data-test": "outside-none" }, [
        h("div", { "data-motion-press": "none", "data-test": "inside-none" }, "No press"),
      ]),
      h("input", { "type": "button", "role": "tab", "class": "plain", "data-test": "input-tab", "value": "Tab" }),
      h("button", { "class": "plain", "data-motion-press": "", "data-test": "opt-wide", "style": { width: "1000px", flexShrink: 0 } }, "A 1000px button"),
    ]),
    ...textRows(row),
    row("Shadow DOM", [h("motion-shadow-button", { "data-test": "shadow-host" })]),
    row("Toggle: switch", [
      h(USwitch, { "data-test": "switch-xl", "modelValue": live.value, "onUpdate:modelValue": (value: boolean) => (live.value = value), label: "Email on deploy", size: "xl", ui: switchUI }),
      h(USwitch, { "data-test": "switch-disabled", "modelValue": false, disabled: true, label: "Disabled" }),
      h("div", { "class": "plain-switch", "role": "switch", "tabindex": 0, "aria-checked": String(plainOn.value), "aria-label": "Plain switch", "data-test": "plain-switch", "onClick": () => (plainOn.value = !plainOn.value), "onKeydown": (event: KeyboardEvent) => {
        if (event.key !== " ") return;
        event.preventDefault();
        plainOn.value = !plainOn.value;
      } }, [h("span", { class: "plain-knob" })]),
    ]),
    row("Toggle: checkbox", [
      h(UCheckbox, { "data-test": "checkbox-mixed", "modelValue": mixed.value, "onUpdate:modelValue": (value: boolean | "indeterminate") => (mixed.value = value), label: "Every file" }),
      h("button", { "class": "plain", "data-test": "set-mixed", "onClick": () => (mixed.value = "indeterminate") }, "Set mixed"),
      h("button", { "class": "plain", "data-test": "set-unchecked", "onClick": () => (mixed.value = false) }, "Clear"),
    ]),
    row("Toggle: pressed icon", [
      h(UButton, { "data-test": "bookmark", "variant": "ghost", "icon": "i-lucide-bookmark", "aria-label": "Save", "aria-pressed": saved.value, "class": buttonClass, "onClick": () => (saved.value = !saved.value) }),
      h(UButton, { "data-test": "star", "variant": "outline", "icon": "i-lucide-star", "label": starred.value ? "Starred" : "Star", "aria-pressed": starred.value, "class": buttonClass, "onClick": () => (starred.value = !starred.value) }),
      h(UButton, { "data-test": "pin", "variant": "ghost", "icon": "i-lucide-pin", "aria-label": "Pin", "aria-pressed": pinned.value, "class": buttonClass, "onClick": () => (pinned.value = !pinned.value) }),
      // An Iconify CSS icon, as `@nuxt/icon` renders one in CSS mode: a span that draws `--svg` as a mask.
      h("button", { "class": "plain", "data-test": "css-bookmark", "aria-label": "Save", "aria-pressed": String(cssSaved.value), "onClick": () => (cssSaved.value = !cssSaved.value) }, [h("span", { class: "iconify css-bookmark" })]),
      h("button", { "class": "plain", "data-test": "inline-mask", "aria-label": "Save", "aria-pressed": String(inlineSaved.value), "onClick": () => (inlineSaved.value = !inlineSaved.value) }, [h(UIcon, { name: "i-lucide-bookmark", mode: "css" })]),
      h(UButton, { "data-test": "bold", "icon": "i-lucide-bold", "aria-label": "Bold", "aria-pressed": bold.value, "onClick": () => (bold.value = !bold.value) }),
      // A segmented control: a choice of one of many, not a toggle. Its icons do not wobble.
      h("div", { class: "segments" }, ["grid", "list"].map(value => h(UButton, { "data-test": `view-${value}`, "variant": "ghost", "icon": value === "grid" ? "i-lucide-layout-grid" : "i-lucide-list", "aria-label": value, "aria-pressed": view.value === value, "onClick": () => (view.value = value) }))),
    ]),
    row("Toggle with data-motion=none", [
      h("div", { "class": "row", "data-motion": "none" }, [
        h(USwitch, { "data-test": "off-switch", "modelValue": offOn.value, "onUpdate:modelValue": (value: boolean) => (offOn.value = value), label: "No motion" }),
        h(UCheckbox, { "data-test": "off-checkbox", "modelValue": offChecked.value, "onUpdate:modelValue": (value: boolean | "indeterminate") => (offChecked.value = value === true), label: "No motion" }),
        h(UButton, { "data-test": "off-bookmark", "variant": "ghost", "icon": "i-lucide-bookmark", "aria-label": "Save", "aria-pressed": offSaved.value, "onClick": () => (offSaved.value = !offSaved.value) }),
      ]),
    ]),
    ...dragRows(),
    ...togetherRows(row),
  ]),
});
const { default: ui } = await import("@nuxt/ui/vue-plugin");
app.use(ui).use(createViteHubUI({ motion: today ? false : pressMode === "opt-in" || pressMode === "all" ? { press: pressMode } : true })).mount("#app");
if (new URLSearchParams(location.search).has("secondApp")) {
  const secondApp = createApp({ render: () => null }).use(createViteHubUI());
  secondApp.mount(document.createElement("div"));
  secondApp.unmount();
}
await document.fonts.ready;
Object.assign(window, { ready: true });
