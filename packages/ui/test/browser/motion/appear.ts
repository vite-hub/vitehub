import { addCollection } from "@iconify/vue";
import lucide from "@iconify-json/lucide/icons.json";
import "@fontsource-variable/geist";
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UDropdownMenu from "@nuxt/ui/components/DropdownMenu.vue";
import UModal from "@nuxt/ui/components/Modal.vue";
import UPopover from "@nuxt/ui/components/Popover.vue";
import USlideover from "@nuxt/ui/components/Slideover.vue";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { useToast } from "@nuxt/ui/composables/useToast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/vue/tooltip";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { VNode } from "vue";

import ConsoleToaster from "../../../../vite-hub/src/console/runtime/components/console-toaster.vue";
import { useConsoleToast } from "../../../../vite-hub/src/console/runtime/client/toast.ts";
import { createViteHubUI } from "../../../src/config.ts";
import { forceReducedMotion, getMotionSlowFactor, prefersReducedMotion, setMotionSlowFactor } from "../../../src/motion.ts";
import "./appear.css";

const today = new URLSearchParams(location.search).get("mode") === "today";
document.documentElement.dataset.mode = today ? "today" : "spring";

const todayTooltip = today ? { content: "data-[state=delayed-open]:animate-[scale-in_100ms_var(--ease-out)] data-[state=closed]:animate-[scale-out_100ms_var(--ease-out)]" } : undefined;
const todayModal = today
  ? {
      overlay: "data-[state=open]:animate-[fade-in_200ms_var(--ease-out)] data-[state=closed]:animate-[fade-out_200ms_var(--ease-out)]",
      content: "data-[state=open]:animate-[scale-in_200ms_var(--ease-out)] data-[state=closed]:animate-[scale-out_200ms_var(--ease-out)]",
    }
  : undefined;

addCollection(lucide);

const slow = ref(getMotionSlowFactor());
const reduced = ref(prefersReducedMotion());
const modalOpen = ref(false);
const slideoverOpen = ref(false);

const tools = [
  { icon: "i-lucide-pencil", label: "Edit" },
  { icon: "i-lucide-copy", label: "Duplicate" },
  { icon: "i-lucide-share", label: "Share" },
  { icon: "i-lucide-bell", label: "Notifications" },
  { icon: "i-lucide-trash-2", label: "Move to trash" },
];

function row(title: string, children: VNode[], attrs: Record<string, unknown> = {}): VNode {
  return h("section", { class: "row", ...attrs }, [h("h2", title), ...children]);
}

const toolbarClass = "inline-flex gap-0.5 rounded-xl border border-default bg-elevated p-1";

const OwnToolbar = defineComponent({
  setup() {
    const tip = ref<HTMLElement>();
    const bar = ref<HTMLElement>();
    let current: HTMLElement | undefined;
    const show = (event: Event, label: string) => {
      const trigger = event.currentTarget as HTMLElement;
      const element = tip.value!;
      current?.removeAttribute("aria-describedby");
      current = trigger;
      trigger.setAttribute("aria-describedby", "own-tip");
      element.textContent = label;
      element.hidden = false;
      const width = element.offsetWidth;
      element.style.left = `${trigger.offsetLeft + trigger.offsetWidth / 2 - width / 2}px`;
      element.style.top = `${trigger.offsetTop - 8 - element.offsetHeight}px`;
      if (!element.hasAttribute("data-open")) element.setAttribute("data-open", "");
    };
    const hide = () => {
      current?.removeAttribute("aria-describedby");
      current = undefined;
      tip.value!.removeAttribute("data-open");
      tip.value!.hidden = true;
    };
    return () => h("div", { "class": "relative inline-block", "data-test": "own-toolbar" }, [
      h("div", { ref: tip, id: "own-tip", role: "tooltip", class: "own-tip", hidden: true, "data-side": "top" }),
      h("div", { ref: bar, class: toolbarClass, onPointerleave: hide }, tools.map(tool => h(UButton, {
        "data-test": `own-${tool.label}`,
        "variant": "ghost",
        "icon": tool.icon,
        "aria-label": tool.label,
        "onPointerenter": (event: Event) => show(event, tool.label),
      }))),
    ]);
  },
});

const Page = defineComponent({
  setup() {
    const toast = useToast();
    const consoleToast = useConsoleToast();
    let count = 0;
    return () => h("main", { class: "page" }, [
      row("Speed and reduced motion", [
        h(UButton, { "data-test": "speed", "variant": "outline", "label": slow.value === 1 ? "1×" : "¼×", "onClick": () => {
          slow.value = slow.value === 1 ? 4 : 1;
          setMotionSlowFactor(slow.value);
        } }),
        h(UButton, { "data-test": "reduce", "variant": "outline", "aria-pressed": reduced.value, "label": reduced.value ? "Reduced motion on" : "Reduced motion off", "onClick": () => {
          reduced.value = !reduced.value;
          forceReducedMotion(reduced.value);
        } }),
      ]),
      row("UTooltip in a toolbar", [
        h("div", { "class": toolbarClass, "data-test": "toolbar" }, tools.map(tool => h(UTooltip, { text: tool.label, content: { side: "top" }, ui: todayTooltip }, () => h(UButton, {
          "data-test": `tool-${tool.label}`,
          "variant": "ghost",
          "icon": tool.icon,
          "aria-label": tool.label,
        })))),
      ]),
      row("One tooltip of our own for a toolbar", [h(OwnToolbar)]),
      row("No motion", [
        h("div", { "data-motion": "none" }, [h(UTooltip, { text: "Still" }, () => h(UButton, { "data-test": "tool-still", "variant": "outline", "label": "data-motion=none" }))]),
        h(Tooltip, null, () => [
          h(TooltipTrigger, { "data-test": "kit-trigger" }, () => "ui-sdk tooltip"),
          h(TooltipContent, { class: "rounded bg-default px-2 py-1 text-sm shadow" }, () => "Native tooltip"),
        ]),
      ]),
      row("Dialogs, side panels, popovers, and menus open at once", [
        h(UButton, { "data-test": "open-modal", "variant": "outline", "label": "Open dialog", "onClick": () => (modalOpen.value = true) }),
        h(UModal, { "open": modalOpen.value, "onUpdate:open": (value: boolean) => (modalOpen.value = value), "title": "Rename project", "description": "The new name shows in the Console.", "ui": todayModal }, {
          body: () => h("div", { "data-test": "modal-body", "class": "text-sm" }, "A dialog opens at once."),
        }),
        h(UButton, { "data-test": "open-slideover", "variant": "outline", "label": "Open side panel", "onClick": () => (slideoverOpen.value = true) }),
        h(USlideover, { "open": slideoverOpen.value, "onUpdate:open": (value: boolean) => (slideoverOpen.value = value), "title": "Logs" }, {
          body: () => h("div", { "data-test": "slideover-body", "class": "text-sm" }, "A side panel opens at once."),
        }),
        h(UPopover, null, {
          default: () => h(UButton, { "data-test": "open-popover", "variant": "outline", "label": "Popover" }),
          content: () => h("div", { "data-test": "popover-body", "class": "p-3 text-sm" }, "A popover opens at once."),
        }),
        h(UDropdownMenu, { items: [{ label: "Rename" }, { label: "Duplicate" }, { label: "Delete" }] }, () => h(UButton, { "data-test": "open-menu", "variant": "outline", "label": "Menu" })),
      ]),
      row("Toasts", [
        h(UButton, { "data-test": "console-toast", "variant": "outline", "label": "Console toast", "onClick": () => {
          count++;
          consoleToast.show({ title: `Changes published (${count})`, duration: 60_000 });
        } }),
        h(UButton, { "data-test": "nuxt-toast", "variant": "outline", "label": "Nuxt UI toast", "onClick": () => {
          count++;
          toast.add({ title: `Deploy started (${count})`, duration: 60_000 });
        } }),
      ]),
      h(ConsoleToaster),
    ]);
  },
});

const app = createApp({
  render: () => h(UApp, { tooltip: { delayDuration: 160 * slow.value, skipDelayDuration: 300 }, toaster: { position: "top-right" } }, () => h(Page)),
});
const { default: ui } = await import("@nuxt/ui/vue-plugin");
app.component("UButton", UButton);
app.use(ui).use(createViteHubUI({ motion: !today })).mount("#app");
await nextTick();
await document.fonts.ready;
Object.assign(window, { ready: true, consoleToast: useConsoleToast() });
