import './assets/main.css'
import '@vite-hub/ui/styles.css'

import ui from '@nuxt/ui/vue-plugin'
import { createViteHubUI } from '@vite-hub/ui'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
})

createApp(App).use(router).use(ui).use(createViteHubUI()).mount('#app')
