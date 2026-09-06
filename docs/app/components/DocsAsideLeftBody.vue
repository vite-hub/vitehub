<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionsForLane } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

type ManifestSection = (typeof docsManifest.sections)[number];
type ManifestPage = ManifestSection["pages"][number];
type SidebarPageGroup = {
  label: string | null;
  pages: ManifestPage[];
};

const route = useRoute();
const currentPath = computed(() => normalizeDocsPath(route.path));
const { lane, pageTarget } = useDocsLane();

const sections = computed(() => {
  return getDocsSectionsForLane(docsManifest.sections, lane.value)
    .map((section) => {
      const pages = section.pages.filter(page => page.navigation !== false);
      const groups = new Map<string | null, ManifestPage[]>();

      for (const page of pages) {
        const label = page.group?.trim() || null;
        groups.set(label, [...(groups.get(label) || []), page]);
      }

      return {
        ...section,
        pageGroups: [...groups].map(([label, groupPages]) => ({ label, pages: groupPages })),
        pages,
      };
    });
});

const sidebarIconMap: Record<string, string> = {
  "i-lucide-activity": "i-ph-activity-light",
  "i-lucide-audio-lines": "i-ph-waveform-light",
  "i-lucide-badge-check": "i-ph-seal-check-light",
  "i-lucide-blocks": "i-ph-squares-four-light",
  "i-lucide-book-open": "i-ph-book-open-light",
  "i-lucide-book-open-check": "i-ph-book-bookmark-light",
  "i-lucide-bot": "i-ph-robot-light",
  "i-lucide-box": "i-ph-cube-light",
  "i-lucide-brain": "i-ph-brain-light",
  "i-lucide-brain-circuit": "i-ph-brain-light",
  "i-lucide-calendar-clock": "i-ph-calendar-check-light",
  "i-lucide-chart-no-axes-column": "i-ph-chart-bar-light",
  "i-lucide-circle-alert": "i-ph-warning-circle-light",
  "i-lucide-clipboard-check": "i-ph-clipboard-text-light",
  "i-lucide-cloud-cog": "i-ph-cloud-light",
  "i-lucide-cloud-upload": "i-ph-cloud-arrow-up-light",
  "i-lucide-code-2": "i-ph-code-light",
  "i-lucide-cpu": "i-ph-cpu-light",
  "i-lucide-database": "i-ph-database-light",
  "i-lucide-database-zap": "i-ph-lightning-light",
  "i-lucide-door-open": "i-ph-door-open-light",
  "i-lucide-download": "i-ph-download-simple-light",
  "i-lucide-file-box": "i-ph-file-light",
  "i-lucide-file-code-2": "i-ph-file-code-light",
  "i-lucide-file-cog": "i-ph-file-code-light",
  "i-lucide-file-text": "i-ph-file-text-light",
  "i-lucide-file-user": "i-ph-identification-card-light",
  "i-lucide-files": "i-ph-files-light",
  "i-lucide-folder-git-2": "i-ph-folder-notch-open-light",
  "i-lucide-folder-input": "i-ph-folder-plus-light",
  "i-lucide-folder-search": "i-ph-file-magnifying-glass-light",
  "i-lucide-folder-tree": "i-ph-tree-structure-light",
  "i-lucide-gauge": "i-ph-gauge-light",
  "i-lucide-git-branch": "i-ph-git-branch-light",
  "i-lucide-git-pull-request": "i-ph-git-pull-request-light",
  "i-lucide-heading": "i-ph-text-h-light",
  "i-lucide-key-round": "i-ph-key-light",
  "i-lucide-list-checks": "i-ph-list-checks-light",
  "i-lucide-list-ordered": "i-ph-list-numbers-light",
  "i-lucide-map": "i-ph-map-trifold-light",
  "i-lucide-message-circle-code": "i-ph-chat-circle-text-light",
  "i-lucide-message-square": "i-ph-chat-text-light",
  "i-lucide-messages-square": "i-ph-chats-circle-light",
  "i-lucide-network": "i-ph-tree-structure-light",
  "i-lucide-package": "i-ph-package-light",
  "i-lucide-panels-top-left": "i-ph-browser-light",
  "i-lucide-play-circle": "i-ph-play-circle-light",
  "i-lucide-plug": "i-ph-plug-light",
  "i-lucide-plug-zap": "i-ph-plug-light",
  "i-lucide-radio": "i-ph-broadcast-light",
  "i-lucide-rocket": "i-ph-rocket-launch-light",
  "i-lucide-route": "i-ph-path-light",
  "i-lucide-scroll-text": "i-ph-scroll-light",
  "i-lucide-search": "i-ph-magnifying-glass-light",
  "i-lucide-send": "i-ph-paper-plane-tilt-light",
  "i-lucide-server": "i-ph-hard-drives-light",
  "i-lucide-server-cog": "i-ph-hard-drives-light",
  "i-lucide-shield-alert": "i-ph-shield-warning-light",
  "i-lucide-shield-check": "i-ph-shield-check-light",
  "i-lucide-sliders-horizontal": "i-ph-sliders-horizontal-light",
  "i-lucide-stethoscope": "i-ph-stethoscope-light",
  "i-lucide-terminal": "i-ph-terminal-light",
  "i-lucide-terminal-square": "i-ph-terminal-window-light",
  "i-lucide-user-check": "i-ph-user-check-light",
  "i-lucide-users-round": "i-ph-users-three-light",
  "i-lucide-workflow": "i-ph-arrows-split-light",
  "i-lucide-wrench": "i-ph-wrench-light",
  "i-simple-icons-vite": "i-ph-lightning-light",
  "i-simple-icons-cloudflare": "i-ph-cloud-light",
  "i-simple-icons-vercel": "i-ph-triangle-light",
  "i-vscode-icons-file-type-markdown": "i-ph-markdown-logo-light",
};

const sidebarSectionIconMap: Record<string, string> = {
  "AI Resources": "i-ph-brain-light",
  "Development": "i-ph-wrench-light",
  "Frameworks and Hosts": "i-ph-plug-light",
  "Reference": "i-ph-book-bookmark-light",
};

const sidebarPageIconMap: Record<string, string> = {
  "/docs/agents": "i-ph-activity-light",
  "/docs/capabilities": "i-ph-sliders-horizontal-light",
  "/docs/concepts": "i-ph-book-bookmark-light",
  "/docs/frameworks-hosts": "i-ph-lightning-light",
  "/docs/getting-started": "i-ph-book-open-light",
  "/docs/reference": "i-ph-package-light",
  "/docs/server-primitives": "i-ph-cube-light",
};

function sidebarIcon(icon: string | null | undefined, fallback = "i-ph-file-text-light") {
  return icon ? sidebarIconMap[icon] || fallback : fallback;
}

function sidebarSectionIcon(section: ManifestSection) {
  return sidebarSectionIconMap[section.title] || sidebarIcon(section.icon, "i-ph-folder-light");
}

function sidebarPageIcon(page: ManifestPage) {
  return sidebarPageIconMap[normalizeDocsPath(page.path)] || sidebarIcon(page.icon);
}

function isActive(path: string) {
  return currentPath.value === normalizeDocsPath(path);
}

function isCurrentSection(section: ManifestSection) {
  return currentPath.value === "/docs"
    ? section.id === "getting-started"
    : section.pages.some(page => isActive(page.path));
}

function isPageGroupOpen(section: ManifestSection, group: SidebarPageGroup, index: number) {
  return group.pages.some(page => isActive(page.path))
    || (index === 0 && isCurrentSection(section));
}

</script>

<template>
  <nav class="vh-docs-sidebar-nav" aria-label="Docs">
    <section
      v-for="section in sections"
      :key="section.id"
      class="vh-docs-sidebar-section"
    >
      <h2 class="vh-docs-sidebar-heading">
        <UIcon :name="sidebarSectionIcon(section)" class="size-4 shrink-0" />
        <span class="min-w-0 truncate">{{ section.title }}</span>
      </h2>

      <div class="vh-docs-sidebar-panel">
        <template v-for="(pageGroup, groupIndex) in section.pageGroups" :key="pageGroup.label || 'pages'">
          <template v-if="pageGroup.label">
            <details
              class="vh-docs-sidebar-page-group group/page-group"
              :open="isPageGroupOpen(section, pageGroup, groupIndex)"
            >
              <summary class="vh-docs-sidebar-page-group-summary">
                <span class="min-w-0 truncate">{{ pageGroup.label }}</span>
                <UIcon name="i-ph-caret-down-light" class="ml-auto size-3 shrink-0 group-open/page-group:rotate-180" />
              </summary>

              <NuxtLink
                v-for="page in pageGroup.pages"
                :key="page.path"
                :to="pageTarget(page)"
                :class="['vh-docs-sidebar-link is-grouped', { 'is-active': isActive(page.path) }]"
                :aria-current="isActive(page.path) ? 'page' : undefined"
              >
                <UIcon :name="sidebarPageIcon(page)" class="size-4 shrink-0" />
                <span class="min-w-0 truncate">{{ page.title }}</span>
              </NuxtLink>
            </details>
          </template>

          <template v-else>
            <NuxtLink
              v-for="page in pageGroup.pages"
              :key="page.path"
              :to="pageTarget(page)"
              :class="['vh-docs-sidebar-link', { 'is-active': isActive(page.path) }]"
              :aria-current="isActive(page.path) ? 'page' : undefined"
            >
              <UIcon :name="sidebarPageIcon(page)" class="size-4 shrink-0" />
              <span class="min-w-0 truncate">{{ page.title }}</span>
            </NuxtLink>
          </template>
        </template>
      </div>
    </section>
  </nav>
</template>

<style scoped>
.vh-docs-sidebar-nav {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0;
}

.vh-docs-sidebar-section {
  border-bottom: 1px solid var(--ui-border);
}

.vh-docs-sidebar-heading {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin: 0;
  padding: 0.75rem 1.25rem 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0.025em;
}

.vh-docs-sidebar-panel {
  padding: 0;
}

.vh-docs-sidebar-page-group {
  border-top: 1px solid color-mix(in srgb, var(--ui-border) 65%, transparent);
}

.vh-docs-sidebar-page-group-summary {
  display: flex;
  cursor: pointer;
  list-style: none;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem 0.375rem 2.25rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-docs-sidebar-page-group-summary::-webkit-details-marker {
  display: none;
}

.vh-docs-sidebar-page-group-summary:hover,
.vh-docs-sidebar-page-group-summary:focus-visible {
  color: var(--ui-text);
}

.vh-docs-sidebar-link {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  border-left: 2px solid transparent;
  padding: 0.25rem 1.25rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease;
}

.vh-docs-sidebar-link.is-grouped {
  padding-left: 2.75rem;
}

.vh-docs-sidebar-link:hover,
.vh-docs-sidebar-link:focus-visible,
.vh-docs-sidebar-link.is-active {
  border-left-color: var(--ui-text-highlighted);
  background: color-mix(in srgb, var(--ui-text-highlighted) 6%, transparent);
  color: var(--ui-text);
}
</style>
