// Effects of different units on one page, so a test sees that they do not fight: tooltips on the tabs of a UTabs
// (select and appear), a USwitch in a toolbar next to a pressed button (toggle and press), and a UButton that starts to
// load in a MotionList row while the list adds a row above it (label and list). `motion-together.browser.mjs` drives it.
import UButton from "@nuxt/ui/components/Button.vue";
import USwitch from "@nuxt/ui/components/Switch.vue";
import UTabs from "@nuxt/ui/components/Tabs.vue";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";
import { TooltipProvider } from "reka-ui";
import { h, ref } from "vue";
import type { VNode } from "vue";

import { MotionList } from "../../../src/components/motion-list.ts";

const tabs = [
  { label: "Preview", value: "preview", tooltip: "Show the page" },
  { label: "Code", value: "code", tooltip: "Show the source" },
  { label: "Logs", value: "logs", tooltip: "Show the requests" },
];
const tab = ref("preview");
const live = ref(false);
const bold = ref(false);
const files = ref([{ id: 1, name: "cover.png" }, { id: 2, name: "notes.md" }]);
const busy = ref<number>();
let next = 3;

// Publish starts to load the row's button and adds a new file above it, so the row moves while its icon swaps.
function publish(id: number): void {
  busy.value = id;
  files.value = [{ id: next, name: `upload-${next}.png` }, ...files.value];
  next++;
}

export function togetherRows(row: (title: string, children: VNode[]) => VNode): VNode[] {
  return [
    row("Together", [
      h(TooltipProvider, { delayDuration: 0, skipDelayDuration: 0 }, () => [
        h(UTabs, { "data-test": "together-tabs", "modelValue": tab.value, "onUpdate:modelValue": (value: string | number) => (tab.value = String(value)), "content": false, "items": tabs }, {
          default: ({ item }: { item: typeof tabs[number] }) => h(UTooltip, { text: item.tooltip }, () => h("span", { "data-test": `together-tab-${item.value}` }, item.label)),
        }),
      ]),
      h("div", { "class": "together-toolbar", "role": "toolbar", "aria-label": "Format", "data-test": "together-toolbar" }, [
        h(UButton, { "data-test": "together-bold", "variant": "ghost", "icon": "i-lucide-bold", "aria-label": "Bold", "aria-pressed": bold.value, "onClick": () => (bold.value = !bold.value) }),
        h(USwitch, { "data-test": "together-switch", "modelValue": live.value, "onUpdate:modelValue": (value: boolean) => (live.value = value), "label": "Live" }),
      ]),
      h(MotionList, { "tag": "ul", "class": "together-list", "data-test": "together-list" }, () => files.value.map(file => h("li", { "key": file.id, "class": "together-row", "data-test": `together-row-${file.id}` }, [
        h("span", file.name),
        h(UButton, {
          "data-test": `together-publish-${file.id}`,
          "size": "sm",
          "label": busy.value === file.id ? "Publishing" : "Publish",
          "loading": busy.value === file.id,
          "icon": "i-lucide-arrow-right",
          "onClick": () => publish(file.id),
        }),
      ]))),
    ]),
  ];
}
