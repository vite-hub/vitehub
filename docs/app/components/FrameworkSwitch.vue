<script setup lang="ts">
// Picks the framework of every framework tab on the site, like a click on one of those tabs.
import { frameworks } from "~/utils/framework"

const framework = useFramework()
</script>

<template>
  <div class="vh-framework-switch" role="radiogroup" aria-label="Framework">
    <button
      v-for="name in frameworks"
      :key="name"
      type="button"
      role="radio"
      :aria-checked="framework === name"
      :data-state="framework === name ? 'active' : 'inactive'"
      @click="framework = name"
    >
      {{ name }}
    </button>
  </div>
</template>

<style scoped>
.vh-framework-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-bg-elevated);
}

.vh-framework-switch button {
  padding: 2px 8px;
  border-radius: var(--ui-radius);
  font-size: 12px;
  line-height: 18px;
  color: var(--ui-text-muted);
}

.vh-framework-switch button[data-state="active"] {
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  box-shadow: 0 0 0 1px var(--ui-border);
}

</style>
