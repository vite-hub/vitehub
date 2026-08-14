import './assets/main.css'

import ui from '@nuxt/ui/vue-plugin'
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).use(ui).mount('#app')
