<script setup lang="ts">
import { onMounted, ref } from "vue"

import { loadConsoleNavigation } from "../client/sections"

const props = defineProps<{
  collapsed?: boolean
  sectionsBase: string
}>()

const projectName = ref<string>()

onMounted(async () => {
  projectName.value = (await loadConsoleNavigation(props.sectionsBase))?.projectName
})
</script>

<template>
  <div class="flex h-10 w-full min-w-0 items-center px-1.5">
    <strong v-if="!collapsed" class="truncate text-[13px] font-semibold text-highlighted">
      {{ projectName ? `ViteHub ${projectName}` : "ViteHub" }}
    </strong>
  </div>
</template>
