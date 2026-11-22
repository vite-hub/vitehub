// `PlaygroundContainer` on the fake WebContainer of the ui-sdk page, in one layout: `?layout=side|guide-side`.
import { defineComponent, h, type PropType } from "vue";

import { PlaygroundContainer } from "../../../../src/workspace/playground-container.ts";
import type { WorkspaceLayout } from "../../../../src/workspace/workspace-shell.ts";
import type { WorkspacePartFixture } from "../main.ts";

const template = {
  files: { "package.json": "{\"name\":\"kv\"}\n", "server/api/health.get.ts": "export default () => 'ok'\n" },
  id: "kv",
  label: "KV",
  open: "server/api/health.get.ts",
  snapshot: async () => new Uint8Array([1]),
};

const component = defineComponent({
  props: { params: { required: true, type: Object as PropType<URLSearchParams> } },
  setup(props) {
    const layout = (props.params.get("layout") ?? "side") as WorkspaceLayout;
    return () => h(PlaygroundContainer, { layout, name: "demo", share: false, templates: [template] });
  },
});

export default { component, ready: ".vh-ws-editor-head .vh-ws-breadcrumb" } satisfies WorkspacePartFixture;
