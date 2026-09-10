<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import { useRoute } from "vue-router"

import { loadConsoleNavigation, subscribeConsoleNavigation } from "../client/sections"
import { resolveConsoleRouteName } from "../console-route"
import ConsoleMark from "./console-mark.vue"

const props = defineProps<{
  collapsed?: boolean
  sectionsBase: string
}>()

const projectName = ref<string>()
const route = useRoute()
let unsubscribeNavigation: (() => void) | undefined

onMounted(async () => {
  unsubscribeNavigation = subscribeConsoleNavigation(props.sectionsBase, (navigation) => {
    projectName.value = navigation.projectName
  })
  projectName.value = (await loadConsoleNavigation(props.sectionsBase))?.projectName
})

onBeforeUnmount(() => unsubscribeNavigation?.())
</script>

<template>
  <div class="flex h-10 w-full min-w-0 items-center gap-2 px-[0.875rem]">
    <ConsoleMark class="size-4 shrink-0" />
    <RouterLink
      v-if="!collapsed"
      class="truncate text-xs font-medium text-muted"
      :to="{ name: resolveConsoleRouteName(route.name, 'vitehub-console') }"
    >
      {{ projectName ? `ViteHub ${projectName}` : "ViteHub" }}
    </RouterLink>
  </div>
</template>
