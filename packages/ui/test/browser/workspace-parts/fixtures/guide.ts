// The learn parts in the shell, as sections 2 and 3 of the prototype: `?layout=guide-top|guide-side`, and
// `&theme=dark` for the dark tokens. The bar holds `WorkspaceSteps` and the guide pane holds `WorkspaceGuide` at the
// "Translate it" step, with a file link and a task. The other slots are plain stand-ins.
import { defineComponent, h, type PropType, ref } from "vue";

import { WorkspaceFileLink, provideWorkspaceFileOpener } from "../../../../src/workspace/workspace-file-link.ts";
import { WorkspaceGuide } from "../../../../src/workspace/workspace-guide.ts";
import { type WorkspaceLayout, WorkspaceShell } from "../../../../src/workspace/workspace-shell.ts";
import { WorkspaceSteps } from "../../../../src/workspace/workspace-steps.ts";
import { WorkspaceTask } from "../../../../src/workspace/workspace-task.ts";
import type { WorkspacePartFixture } from "../main.ts";

const steps = [
  { title: "Write a component", description: "Glosa reads the text. No t() calls.", open: "src/components/Greeting.vue" },
  { title: "Translate it", description: "One catalog per locale, keyed by hash.", open: "locales/es.json" },
  { title: "Plurals", description: "Counts that read right in every locale.", open: "src/components/Inbox.vue" },
  { title: "Fallbacks", description: "What shows before a translation exists.", open: "locales/de.json" },
];

const fill = (label: string) => () => h("div", { "data-stand-in": label, style: "flex: 1; min-height: 0" }, label);

const component = defineComponent({
  props: { params: { required: true, type: Object as PropType<URLSearchParams> } },
  setup(props) {
    const layout = (props.params.get("layout") ?? "guide-top") as WorkspaceLayout;
    if (props.params.get("theme") === "dark") document.documentElement.classList.add("dark");
    const step = ref(1);
    const file = ref("locales/es.json");
    provideWorkspaceFileOpener({ show: (path) => { file.value = path; } });
    // A new step opens its own file, as on the learn page.
    const setStep = (value: number) => {
      step.value = value;
      file.value = steps[value]!.open;
    };

    return () => h(WorkspaceShell, { layout, storageKey: false, style: "border: 0; border-radius: 0" }, {
      bar: () => h(WorkspaceSteps, { label: "Translate an app", step: step.value, steps, "onUpdate:step": setStep }),
      files: fill("files"),
      "editor-head": () => h("span", { "data-file": "" }, file.value),
      editor: fill("editor"),
      status: () => h("span", "JSON"),
      guide: () => h(WorkspaceGuide, { step: step.value, steps, "onUpdate:step": setStep }, () => [
        h("p", "Each locale has one catalog. A key is a hash of the English text, so the key changes when the text changes."),
        h("p", [h(WorkspaceFileLink, { path: "locales/es.json" }), " is open below. Edit a value and the preview reloads in Spanish."]),
        h(WorkspaceTask, () => "The German catalog has no “Start translating”. Open the Messages tab on the right to see which ones are missing."),
      ]),
      preview: fill("preview"),
      terminal: fill("terminal"),
    });
  },
});

export default { component, ready: ".vh-ws-guide-footer .vh-ws-guide-next" } satisfies WorkspacePartFixture;
