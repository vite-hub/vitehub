// `WorkspaceShell` in one layout, `?layout=side|guide-top|guide-side`, with every slot set to a plain stand-in. The
// stand-ins fill their slot, so the rects are the rects of the shell.
import { defineComponent, h, type PropType } from "vue";

import { type WorkspaceLayout, WorkspaceShell } from "../../../../src/workspace/workspace-shell.ts";
import type { WorkspacePartFixture } from "../main.ts";

const fill = (label: string) => () => h("div", { "data-stand-in": label, style: "flex: 1; min-height: 0" }, label);

const component = defineComponent({
  props: { params: { required: true, type: Object as PropType<URLSearchParams> } },
  setup(props) {
    const layout = (props.params.get("layout") ?? "side") as WorkspaceLayout;
    return () => h(WorkspaceShell, { layout, storageKey: false, style: "border: 0; border-radius: 0" }, {
      bar: fill("bar"),
      files: fill("files"),
      "editor-head": () => h("span", "src/app.vue"),
      editor: fill("editor"),
      status: () => h("span", "Vue"),
      guide: fill("guide"),
      preview: fill("preview"),
      terminal: fill("terminal"),
    });
  },
});

export default { component, ready: ".vh-ws-tab-list [role=tab]" } satisfies WorkspacePartFixture;
