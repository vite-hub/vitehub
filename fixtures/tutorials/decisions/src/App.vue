<script setup lang="ts">
import { ref } from "vue"
import { useChoices } from "vite-hub/decisions/vue"
import type { forecast } from "../server/utils/forecast-choices"

// Your state. Choices never touches it.
const included = ref<string[]>([])
const excluded = ref<string[]>([])
const chart = ref<string | null>(null)

const ai = useChoices<typeof forecast>({
  // Bridge to the server: send the text, return the selection.
  resolve: async (text, { signal }) => {
    const response = await fetch("/api/choices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    })
    if (!response.ok) throw new Error((await response.json()).message)
    return response.json()
  },
  // Bridge out: apply the selection to your state.
  onSelect: (selection) => {
    included.value = selection.supplier.include
    excluded.value = selection.supplier.exclude
    chart.value = selection.chart.value
  },
})
</script>

<template>
  <input v-model="ai.text.value" placeholder="nord parts except vak supply, as bar" @keydown.enter="ai.submit()">
  <p v-if="ai.status.value === 'thinking'">Thinking</p>
  <p v-else-if="ai.error.value">{{ ai.error.value.message }}</p>
  <ul>
    <li v-for="id in included" :key="id">Supplier: {{ id }}</li>
    <li v-for="id in excluded" :key="id">Not supplier: {{ id }}</li>
    <li v-if="chart">Chart: {{ chart }}</li>
  </ul>
</template>
