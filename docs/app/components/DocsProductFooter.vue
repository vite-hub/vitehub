<script setup lang="ts">
// The footer of a product landing page: every documented area by category, with the current one marked.
import { docsManifest, type DocsSection } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsCatalog } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const props = defineProps<{
  current: DocsSection;
}>();

const groups = getDocsCatalog(docsManifest.sections);

function isCurrent(section: DocsSection) {
  return section.id === props.current.id;
}
</script>

<template>
  <footer class="vh-product-footer" aria-label="Explore ViteHub documentation">
    <h2 class="vh-product-footer-title">Explore ViteHub</h2>

    <div class="vh-product-footer-grid">
      <section v-for="group in groups" :key="group.category" class="vh-product-footer-group">
        <h3 class="vh-product-footer-category">{{ group.category }}</h3>
        <ul class="vh-product-footer-list">
          <li v-for="section in group.sections" :key="section.id">
            <NuxtLink
              :to="section.path"
              class="vh-product-footer-link"
              :class="{ 'is-current': isCurrent(section) }"
              :aria-current="isCurrent(section) ? 'page' : undefined"
            >
              <UIcon :name="sidebarSectionIcon(section)" class="mt-[0.1875rem] size-4 shrink-0" />
              <span class="min-w-0">{{ section.title }}</span>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </div>
  </footer>
</template>

<style scoped>
.vh-product-footer {
  margin-top: 4rem;
  border-top: 1px solid var(--ui-border);
  padding-top: 2rem;
}

.vh-product-footer-title {
  margin: 0 0 1.25rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* Columns keep a readable width and fill the row, so long section titles fit instead of truncating. */
.vh-product-footer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
  gap: 1.5rem;
}

.vh-product-footer-category {
  margin: 0 0 0.5rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-product-footer-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.vh-product-footer-link {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.1875rem 0;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  line-height: 1.375rem;
  transition: color 150ms ease;
}

.vh-product-footer-link:hover {
  color: var(--ui-text-highlighted);
}

.vh-product-footer-link.is-current {
  color: var(--ui-text-highlighted);
  font-weight: 500;
}
</style>
