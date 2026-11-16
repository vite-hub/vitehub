// The icon parity page (`icons.html`): every Console icon name, drawn by Nuxt UI's `UIcon` and by the Console `Icon`,
// with the Console's stylesheet and icon setup. `packages/vite-hub/test/console-icon.browser.mjs` compares the two.
import "../../packages/vite-hub/src/console/runtime/client/styles.css"

import ui from "@nuxt/ui/vue-plugin"
import { createApp } from "vue"

import { addViteHubIcons, deferLucideIcons } from "../../packages/vite-hub/src/console/runtime/client/icons.ts"
import Icons from "./icons.vue"

addViteHubIcons()
deferLucideIcons()
createApp(Icons).use(ui).mount("#app")
