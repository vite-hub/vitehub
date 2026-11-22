import "../../packages/vite-hub/src/console/runtime/client/styles.css"

import ui from "@nuxt/ui/vue-plugin"
import { createApp } from "vue"

import { addViteHubIcons, deferLucideIcons } from "../../packages/vite-hub/src/console/runtime/client/icons.ts"
import Icons from "./icons.vue"

addViteHubIcons()
deferLucideIcons()
createApp(Icons).use(ui).mount("#app")
