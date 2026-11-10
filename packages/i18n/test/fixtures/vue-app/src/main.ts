import { createApp } from "vue"
import { createI18n } from "@vite-hub/i18n/vue"
import App from "./App.vue"

createApp(App).use(await createI18n()).mount("#app")
