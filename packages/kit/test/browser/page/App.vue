<script setup lang="ts">
import type { Component } from "vue"

// `?view=all` renders every example closed. `?view=<name>` renders one example, open when `open/<name>.vue` exists.
const parts = import.meta.glob<{ default: Component }>("./parts/*.vue", { eager: true })
const open = import.meta.glob<{ default: Component }>("./open/*.vue", { eager: true })
const view = new URLSearchParams(location.search).get("view") ?? "all"

function entries(modules: Record<string, { default: Component }>) {
  return Object.entries(modules).map(([path, module]) => ({ name: path.split("/").pop()!.replace(".vue", ""), component: module.default }))
}

const shown = view === "all"
  ? entries(parts).filter(entry => entry.name !== "tooltip")
  : [entries(open).concat(entries(parts)).find(entry => entry.name === view)].filter(entry => entry !== undefined)
</script>

<template>
  <main class="fixture" :data-view="view">
    <section v-for="entry in shown" :key="entry.name" :data-part="entry.name">
      <h2>{{ entry.name }}</h2>
      <component :is="entry.component" />
    </section>
  </main>
</template>
