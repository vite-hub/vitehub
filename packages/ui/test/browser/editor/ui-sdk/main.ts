import "./styles.css";

import { createApp } from "vue";

import { createViteHubUI } from "../../../../src/config.ts";
import { uiSdkComponents } from "../../../../src/ui-sdk/components.ts";
import { EditorPage } from "../editor-page.ts";

createApp(EditorPage).use(createViteHubUI({ components: uiSdkComponents })).mount("#app");
