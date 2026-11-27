<script setup lang="ts">
import { useDocsHeaderActionsTarget } from "../composables/headerActions"

// Wide screens have no site header beside the docs sidebar, so its foot holds the repository, the community links, and
// the color mode button. Phones keep them in the header and its menu.
// A collapsed sidebar stacks them in its narrow column, as icons.
defineProps<{ stacked?: boolean }>()
const { github, site, socials } = useDocsConfig()
const actionsTargetId = useDocsHeaderActionsTarget()
const id = `docs-header-actions-${useId()}`
// Register only after hydration. The server and the first client render keep the action in the header.
onMounted(() => { actionsTargetId.value = id })
onBeforeUnmount(() => {
  if (actionsTargetId.value === id) actionsTargetId.value = null
})
// Nuxt turns a `null` in runtime config into "", so only a number counts.
const stars = github && typeof github.stars === "number" ? new Intl.NumberFormat("en", { notation: "compact" }).format(github.stars) : null
</script>

<template>
  <div class="vh-docs-aside-footer" :class="{ 'is-stacked': stacked }">
    <div :id="id" class="contents" />
    <a
      v-if="github"
      :href="github.url"
      target="_blank"
      rel="noopener"
      class="vh-docs-aside-github"
      :aria-label="stars ? `${site.name} on GitHub, ${stars} stars` : `${site.name} on GitHub`"
    >
      <UIcon name="i-simple-icons-github" class="size-4 shrink-0" />
      <span v-if="stars && !stacked" class="vh-docs-aside-stars">
        <UIcon name="i-lucide-star" class="size-3.5 shrink-0" />
        {{ stars }}
      </span>
    </a>
    <UButton
      v-for="link in socials"
      :key="link.to"
      :to="link.to"
      target="_blank"
      :icon="link.icon"
      :label="link.icon ? undefined : link.label"
      color="neutral"
      variant="ghost"
      size="sm"
      :aria-label="link.label"
    />
    <!-- The button renders both icons and the color mode class picks one, so the server draws it too. -->
    <UColorModeButton color="neutral" variant="ghost" size="sm" :class="{ 'ms-auto': !stacked }" />
  </div>
</template>

<style scoped>
.vh-docs-aside-footer {
  display: flex;
  flex-wrap: wrap;
  flex: none;
  align-items: center;
  gap: 0.25rem;
  border-top: 1px solid var(--ui-border);
  padding: 0.5rem 0.75rem;
}

.vh-docs-aside-footer.is-stacked {
  flex-direction: column;
  padding: 0.5rem 0;
}

.vh-docs-aside-github {
  display: inline-flex;
  height: 1.75rem;
  align-items: center;
  gap: 0.5rem;
  border-radius: var(--ui-radius);
  padding-inline: 0.375rem;
  color: var(--ui-text-highlighted);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  transition: background-color 150ms ease;
}

.vh-docs-aside-github:hover {
  background: var(--ui-bg-elevated);
}


.vh-docs-aside-stars {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--ui-text-muted);
}
</style>
