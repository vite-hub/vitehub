<script setup lang="ts">
// `:::mcp-client{label icon method}` inside `::mcp-install`: the setup of one client. Its Markdown is the steps,
// usually a numbered list, which shows as numbered circles. `install` adds the client's one-click install link,
// and `note` adds a footer line.
import { docsMcpInstallLinks } from "#docs/navigation"

const props = defineProps<{
  label: string
  icon?: string
  /** How the server gets into this client, such as "Terminal" or "Settings". */
  method?: string
  /** A client with a one-click install link from the site's MCP config. */
  install?: "cursor" | "vscode"
  note?: string
}>()

const { mcp, site } = useDocsConfig()
const installUrl = computed(() => props.install && mcp ? docsMcpInstallLinks(mcp)[props.install] : undefined)
</script>

<template>
  <article class="vh-mcp-guide" :aria-label="`${label} setup`">
    <header class="vh-mcp-guide-header">
      <span class="vh-mcp-guide-logo"><UIcon :name="icon ?? 'i-lucide-plug'" aria-hidden="true" /></span>
      <div class="vh-mcp-guide-title">
        <h3>Add the {{ site.name }} MCP to {{ label }}</h3>
        <p v-if="method">{{ method }}</p>
      </div>
      <UButton
        v-if="installUrl"
        :to="installUrl"
        external
        size="sm"
        variant="outline"
        color="neutral"
        trailing-icon="i-lucide-arrow-up-right"
        :label="`Add to ${label}`"
      />
    </header>
    <div class="vh-mcp-guide-body">
      <slot />
    </div>
    <footer v-if="note" class="vh-mcp-guide-note">{{ note }}</footer>
  </article>
</template>

<style scoped>
.vh-mcp-guide {
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 3);
  background: var(--ui-bg);
}

.vh-mcp-guide-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--ui-border);
}

.vh-mcp-guide-logo {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  font-size: 1.25rem;
}

.vh-mcp-guide-title {
  flex: 1 1 10rem;
  min-width: 0;
}

.vh-mcp-guide-title h3 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25rem;
  color: var(--ui-text-highlighted);
}

.vh-mcp-guide-title p {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--ui-text-muted);
}

.vh-mcp-guide-body {
  padding: 1rem;
  font-size: 0.875rem;
  line-height: 1.375rem;
  color: var(--ui-text-muted);
}

.vh-mcp-guide-body :deep(> :first-child) {
  margin-top: 0;
}

.vh-mcp-guide-body :deep(> :last-child) {
  margin-bottom: 0;
}

.vh-mcp-guide-body :deep(p) {
  margin-block: 0.5rem;
}

.vh-mcp-guide-body :deep(code:not(pre code)) {
  color: var(--ui-text-highlighted);
}

/* Numbered steps: each item gets its number in a circle, like a setup guide. */
.vh-mcp-guide-body :deep(ol) {
  display: grid;
  gap: 0.875rem;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: vh-mcp-step;
}

.vh-mcp-guide-body :deep(ol > li) {
  position: relative;
  min-width: 0;
  margin: 0;
  padding-left: 2.25rem;
  counter-increment: vh-mcp-step;
}

.vh-mcp-guide-body :deep(ol > li)::before {
  content: counter(vh-mcp-step);
  position: absolute;
  top: -0.0625rem;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-toned);
}

.vh-mcp-guide-body :deep(ol > li > p:first-child) {
  margin-top: 0;
}

.vh-mcp-guide-body :deep(li .code-block-wrapper) {
  margin-block: 0.5rem 0;
}

.vh-mcp-guide-note {
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-size: 0.75rem;
  line-height: 1.25rem;
  color: var(--ui-text-muted);
}
</style>
