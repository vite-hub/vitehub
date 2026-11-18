import "./styles.css";

import { createApp } from "vue";

import { createViteHubUI } from "../../../src/config.ts";
import { uiSdkComponents } from "../../../src/ui-sdk/components.ts";
import { Parts } from "./parts.ts";

createApp(Parts).use(createViteHubUI({ components: uiSdkComponents })).mount("#app");
