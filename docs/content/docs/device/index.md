---
title: Device
layout: landing
navigation.title: Overview
description: Show the last server answer at once from the browser, for the signed-in account, then refresh it.
navigation.order: 1
icon: i-lucide-hard-drive
---

::product-hero{tagline="Show the last server answer at once, from the device, for the signed-in account. Then ask the server again."}
  :::code-tree
  ```ts [src/main.ts]
  import { createApp } from 'vue'
  import { openDevice } from 'vite-hub/device'
  import App from './App.vue'

  // Read the stored answers before the first render
  await openDevice({ version: '1' })
  createApp(App).mount('#app')
  ```

  ```vue [src/components/ProjectList.vue]
  <script setup lang="ts">
  import { useStoredData } from 'vite-hub/device/vue'

  // The last answer at once, then the new one
  const { data: projects } = useStoredData('projects', () =>
    fetch('/api/projects').then(response => response.json()), { default: () => [] })
  </script>

  <template>
    <li v-for="project in projects" :key="project.id">{{ project.name }}</li>
  </template>
  ```
  :::
::

## What you get

| Part | What it does |
| --- | --- |
| Stored reads | `useStoredData()` shows the stored answer in the first render, then calls your loader. It has the shape of Nuxt `useAsyncData()`. |
| One account | The device holds the copies of the account that your session read names with its `account` option, or that you name with `setDeviceAccount()`. Another account, or a sign-out, deletes them in every tab. |
| No account, no disk | The device stores only the answers of loader calls that start after the page names an account, and the answer of the session read that names it. An app that names no account stores nothing. |
| Caps | A copy older than `maxAge` (7 days by default) does not show. The device keeps at most 5 MB, and deletes the oldest copies first. |
| Versions | `openDevice({ version })` deletes the copies of another version, so a new build does not show data of an old shape. |
| Fallback | In a private window or a sandboxed frame without IndexedDB, the copies stay in memory. |
| Inspection | `inspectDevice()` gives the account, the storage, and each copy with its key, time, and size. |

A stored copy only changes what the screen shows first. The server still checks every request.

## Next

- [Get started](/docs/device/get-started): a project list that shows at once on a reload.
- [Browser API](/docs/device/browser-api): every function and option.
- [Limits and errors](/docs/device/limits-and-errors): what the device does not do, and the `DEVICE_*` codes.
