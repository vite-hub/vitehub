<script setup lang="ts">
import { onMounted, ref } from "vue"
import { useRoute } from "vue-router"

import { loadConsoleNavigation } from "../client/sections"
import { resolveConsoleRouteName } from "../console-route"

const props = defineProps<{
  collapsed?: boolean
  sectionsBase: string
}>()

const projectName = ref<string>()
const route = useRoute()

onMounted(async () => {
  projectName.value = (await loadConsoleNavigation(props.sectionsBase))?.projectName
})
</script>

<template>
  <div class="flex h-10 w-full min-w-0 items-center px-1.5">
    <RouterLink
      v-if="!collapsed"
      class="truncate text-[13px] font-semibold text-highlighted"
      :to="{ name: resolveConsoleRouteName(route.name, 'vitehub-console') }"
    >
      {{ projectName ? `ViteHub ${projectName}` : "ViteHub" }}
    </RouterLink>
  </div>
</template>
