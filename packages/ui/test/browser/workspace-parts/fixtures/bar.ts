// `WorkspaceBar` with `WorkspaceExamples`, `WorkspaceSidebar` and, with `?start=1`, `WorkspaceStart`, in the bar slot
// of a `side` shell, as in sections 1 and 4 of the prototype. `?sidebar=open` opens the sidebar.
import { defineComponent, h, type PropType, ref } from "vue";

import { useUIComponent } from "../../../../src/internal/nuxt-ui.ts";
import { WorkspaceBar } from "../../../../src/workspace/workspace-bar.ts";
import { WorkspaceExamples } from "../../../../src/workspace/workspace-examples.ts";
import { WorkspaceShell } from "../../../../src/workspace/workspace-shell.ts";
import { WorkspaceSidebar } from "../../../../src/workspace/workspace-sidebar.ts";
import { WorkspaceStart } from "../../../../src/workspace/workspace-start.ts";
import type { WorkspacePartFixture } from "../main.ts";
import { examples, theme } from "../examples.ts";

const fill = (label: string) => () => h("div", { "data-stand-in": label, style: "flex: 1; min-height: 0" }, label);

const component = defineComponent({
  props: { params: { required: true, type: Object as PropType<URLSearchParams> } },
  setup(props) {
    theme(props.params);
    const UButton = useUIComponent("UButton");
    const sidebar = ref(props.params.get("sidebar") === "open");
    const example = ref("vue");
    const start = ref(props.params.get("start") === "1");
    const events = ref<string[]>([]);
    const record = (event: string) => { events.value = [...events.value, event]; };
    return () => h(WorkspaceShell, { layout: "side", storageKey: false, style: "border: 0; border-radius: 0" }, {
      bar: () => [
        h(WorkspaceBar, { sidebar: sidebar.value, sidebarId: "sidebar", "onUpdate:sidebar": (open: boolean) => { sidebar.value = open; } }, {
          examples: () => h(WorkspaceExamples, { examples, modelValue: example.value, "onUpdate:modelValue": (id: string) => { example.value = id; } }),
          default: () => h("span", { class: "vh-workspace-run-state", "data-state": "" }, "Running"),
          actions: () => [
            h(UButton, { color: "neutral", icon: "i-lucide-rotate-ccw", label: "Reset", variant: "ghost" }),
            h(UButton, { color: "neutral", icon: "i-lucide-download", label: "Download", variant: "ghost" }),
            h(UButton, { color: "neutral", icon: "i-lucide-link", label: "Copy link", variant: "outline" }),
            h(UButton, { "aria-label": "More actions", color: "neutral", icon: "i-lucide-ellipsis", variant: "ghost" }),
          ],
        }),
        h(WorkspaceSidebar, {
          id: "sidebar",
          open: sidebar.value,
          "onUpdate:open": (open: boolean) => { sidebar.value = open; },
          onReset: () => record("reset"),
          onDownload: () => record("download"),
          "onCopy-link": () => record("copy-link"),
        }, () => [
          h("h4", { class: "vh-ws-sidebar-heading" }, "Docs"),
          ...["Introduction", "Install", "Extraction"].map(page => h("a", { class: "vh-ws-sidebar-link", href: "#" }, page)),
        ]),
        start.value ? h(WorkspaceStart, { examples, onPick: (id: string) => { example.value = id; start.value = false; } }) : undefined,
      ],
      files: fill("files"),
      "editor-head": () => h("span", { "data-example": example.value }, `${example.value}/src/app.vue`),
      editor: fill("editor"),
      status: () => h("span", events.value.join(" ")),
      preview: fill("preview"),
      terminal: fill("terminal"),
    });
  },
});

export default { component, ready: ".vh-ws-topbar" } satisfies WorkspacePartFixture;
