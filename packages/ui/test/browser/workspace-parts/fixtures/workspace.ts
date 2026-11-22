// `Workspace` as each section of the prototype, `?section=1..5`, on the fake WebContainer of the ui-sdk page:
// 1 the examples and a sidebar in the `side` layout, 2 a lesson with the guide over the code, 3 a lesson with the guide
// in a column, 4 the start screen, and 5 the `render()` runner. `&theme=dark` puts the page in dark mode.
import { defineComponent, h, type PropType } from "vue";

import { render } from "../../../../src/workspace/runners/render.ts";
import { webContainer } from "../../../../src/workspace/runners/web-container.ts";
import type { WorkspaceExample } from "../../../../src/workspace/workspace-examples.ts";
import { WorkspaceTask } from "../../../../src/workspace/workspace-task.ts";
import { Workspace } from "../../../../src/workspace/workspace.ts";
import type { WorkspacePartFixture } from "../main.ts";
import { examples, theme } from "../examples.ts";

// The prototype draws the sections edge to edge.
const style = document.createElement("style");
style.textContent = ".vh-workspace .vh-ws-shell { border: 0; border-radius: 0; }";
document.head.append(style);

const snapshot = async () => new Uint8Array([1]);

const lesson: WorkspaceExample = {
  files: {
    "locales/de.json": "{}\n",
    "locales/es.json": "{\n  \"a1f3\": \"Bienvenido de nuevo\"\n}\n",
    "package.json": "{}\n",
    "src/components/Greeting.vue": "<template>\n  <h1>Welcome back</h1>\n</template>\n",
  },
  id: "translate",
  label: "Translate an app",
  open: "locales/es.json",
};
const steps = [
  { title: "Write a component", description: "Glosa reads the text. No t() calls." },
  { title: "Translate it", description: "One catalog per locale, keyed by hash." },
  { title: "Plurals", description: "Counts that read right in every locale." },
  { title: "Fallbacks", description: "What shows before a translation exists." },
];

const model: WorkspaceExample = {
  files: {
    "data/dev.jsonl": "{}\n",
    "data/train.jsonl": "{}\n",
    "name-tagger.model.ts": "import { defineModel } from \"gpu-engine\"\n\nexport default defineModel({ name: \"name-tagger\" })\n",
  },
  id: "name-tagger",
  label: "Name tagger",
  open: "name-tagger.model.ts",
};

const component = defineComponent({
  props: { params: { required: true, type: Object as PropType<URLSearchParams> } },
  setup(props) {
    theme(props.params);
    const section = props.params.get("section") ?? "1";
    const runner = webContainer({ snapshot: () => snapshot });
    if (section === "2" || section === "3") {
      return () => h(Workspace, { examples: [lesson], guide: section === "2" ? "top" : "side", name: "demo", runner, share: false, steps, step: 1 }, {
        guide: () => [
          h("p", "Each locale has one catalog. A key is a hash of the English text."),
          h(WorkspaceTask, () => "Translate the greeting to German."),
        ],
      });
    }
    if (section === "5") {
      const tagger = render(async files => ({ html: `<pre>${Object.keys(files).join("\n")}</pre>`, issues: [] }));
      return () => h(Workspace, { examples: [model], name: "demo", runner: tagger });
    }
    return () => h(Workspace, { examples, name: "demo", runner, start: section === "4" }, {
      sidebar: () => [
        h("h4", { class: "vh-ws-sidebar-heading" }, "Docs"),
        ...["Introduction", "Install", "Extraction"].map(page => h("a", { class: "vh-ws-sidebar-link", href: "#" }, page)),
      ],
    });
  },
});

export default {
  component,
  ready: new URLSearchParams(location.search).get("section") === "4" ? ".vh-ws-start-card" : ".vh-ws-editor .cm-content",
} satisfies WorkspacePartFixture;
