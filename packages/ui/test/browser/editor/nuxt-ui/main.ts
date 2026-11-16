import "./main.css";

import UApp from "@nuxt/ui/components/App.vue";
import ui from "@nuxt/ui/vue-plugin";
import { createApp, h } from "vue";

import { EditorPage } from "../editor-page.ts";

createApp({ render: () => h(UApp, () => h(EditorPage)) }).use(ui).mount("#app");
