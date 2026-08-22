import './assets/main.css'
import '@vite-hub/ui/styles.css'

import ui from '@nuxt/ui/vue-plugin'
import { createViteHubUI } from '@vite-hub/ui'
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).use(ui).use(createViteHubUI()).mount('#app')
