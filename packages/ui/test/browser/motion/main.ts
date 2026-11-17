// The motion page: every role that the motion layer of `@vite-hub/ui/motion` moves, with Nuxt UI components and with
// plain elements. `?mode=today` turns the layer off and gives UButton the press of the theme before the layer, to record
// both. The bar on top sets the speed (1×, ¼×) and reduced motion. Each later effect adds its role here.
import { addCollection } from "@iconify/vue";
import lucide from "@iconify-json/lucide/icons.json";
import "@fontsource-variable/geist";
import UButton from "@nuxt/ui/components/Button.vue";
import UCheckbox from "@nuxt/ui/components/Checkbox.vue";
import URadioGroup from "@nuxt/ui/components/RadioGroup.vue";
import USwitch from "@nuxt/ui/components/Switch.vue";
import UTabs from "@nuxt/ui/components/Tabs.vue";
import { createApp, h, ref } from "vue";
import type { VNode } from "vue";

import { createViteHubUI } from "../../../src/config.ts";
import { forceReducedMotion, getMotionSlowFactor, prefersReducedMotion, setMotionSlowFactor } from "../../../src/motion.ts";
import "./styles.css";

const today = new URLSearchParams(location.search).get("mode") === "today";
// The press of `vitehubTheme.button` before the motion layer.
const todayPress = "transition-[color,background-color,box-shadow,transform] duration-150 ease-out motion-safe:active:not-disabled:scale-[.97]";
const buttonClass = today ? todayPress : undefined;
// The thumb of USwitch before the motion layer: a CSS transition on its translate, and one size.
const todayThumb = "transition-transform duration-200 ease-out data-[state=unchecked]:scale-100";
const switchUI = today ? { thumb: todayThumb } : undefined;

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
const view = ref("grid");
const offOn = ref(false);
const offChecked = ref(false);
const offSaved = ref(false);

const plainRoles = ["button", "link", "tab", "radio", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "switch", "checkbox"];

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
      h(UTabs, { "data-test": "tabs", "modelValue": tab.value, "onUpdate:modelValue": (value: string | number) => (tab.value = String(value)), content: false, items: [{ label: "Overview", value: "overview" }, { label: "Logs", value: "logs" }, { label: "Settings", value: "settings" }] }),
    ]),
    row("USwitch, UCheckbox, URadioGroup", [
      h(USwitch, { "data-test": "switch", "modelValue": on.value, "onUpdate:modelValue": (value: boolean) => (on.value = value), label: "Live", ui: switchUI }),
      h(UCheckbox, { "data-test": "checkbox", "modelValue": checked.value, "onUpdate:modelValue": (value: boolean | "indeterminate") => (checked.value = value === true), label: "Notify me" }),
      h(URadioGroup, { "data-test": "radio", "modelValue": plan.value, "onUpdate:modelValue": (value: string) => (plan.value = value), orientation: "horizontal", items: [{ label: "Free", value: "free" }, { label: "Pro", value: "pro" }] }),
    ]),
    row("Plain elements by role", [
      h("button", { "class": "plain", "data-test": "plain-button" }, "button"),
      h("a", { "class": "plain", "href": "#a", "data-test": "plain-a" }, "a[href]"),
      h("details", [h("summary", { "class": "plain", "data-test": "plain-summary" }, "summary")]),
      ...plainRoles.map(role => h("div", { "class": "plain", role, "tabindex": 0, "data-test": `role-${role}` }, `role=${role}`)),
    ]),
    row("No motion", [
      h("button", { "class": "plain", "disabled": true, "data-test": "plain-disabled" }, "disabled"),
      h("div", { "class": "plain", "role": "button", "aria-disabled": "true", "tabindex": 0, "data-test": "aria-disabled" }, "aria-disabled"),
      h("div", { "data-motion": "none" }, [h("button", { "class": "plain", "data-test": "opt-out" }, "inside data-motion=none")]),
      h("button", { "class": "plain own-press", "data-test": "own-press" }, "own scale transition"),
      h("button", { "class": "plain", "data-test": "not-a-control-parent" }, [h("span", { "data-test": "inner-span" }, "span in a button")]),
    ]),
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
  ]),
});
const { default: ui } = await import("@nuxt/ui/vue-plugin");
app.use(ui).use(createViteHubUI({ motion: !today })).mount("#app");
await document.fonts.ready;
Object.assign(window, { ready: true });
