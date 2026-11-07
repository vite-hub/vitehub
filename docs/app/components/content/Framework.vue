<script setup lang="ts">
// `::framework{name="Nitro"}` shows its content only to readers who picked that framework in a framework tab.
// `::product-files` reads the code blocks inside it the same way, so a landing hero shows one config file.
import type { Framework } from "~/utils/framework"

defineOptions({ name: "Framework" })
const props = defineProps<{ name: Framework }>()
const framework = useFramework()
</script>

<template>
  <div v-if="framework === props.name">
    <slot />
  </div>
</template>
