<script setup lang="ts">
// `::product-hero` opens a product landing page. The copy comes from the page frontmatter and the
// section manifest. The default slot renders in the right column: a `::code-group` whose tabs become
// a file list beside the code, or an interactive component.
import { docsManifest, getDocsPageByPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  getDocsSectionForPath,
  getDocsSectionSubpages,
  getDocsSidebarGroups,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const props = defineProps<{
  /** One sentence of 20 words or fewer, shown instead of the frontmatter description. */
  tagline?: string;
  /** Comma-separated hosts the primitive deploys on, as the product's hosts page lists them. */
  hosts?: string;
  /** Built-in inbound Agent Channels, or examples of application-owned outbound connectors. */
  channels?: string;
  channelMode?: "builtin" | "custom";
}>();

const route = useRoute();
const page = computed(() => getDocsPageByPath(route.path));
const section = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
const subpages = computed(() => (section.value ? getDocsSectionSubpages(section.value) : []));
const getStarted = computed(
  () => subpages.value.find((candidate) => candidate.id === "get-started") ?? subpages.value[0],
);
const serverApi = computed(() => subpages.value.find((candidate) => candidate.id === "server-api"));
const secondaryPage = computed(
  () => serverApi.value ?? subpages.value.find((candidate) => candidate.id === "invocations"),
);
const heroPages = computed(() => {
  if (!section.value) return [];
  if (section.value.id !== "agents")
    return subpages.value.filter(
      (candidate) =>
        candidate.path !== getStarted.value?.path && candidate.path !== secondaryPage.value?.path,
    );
  return getDocsSidebarGroups(section.value)
    .map((group) => group.pages[0])
    .filter((page): page is NonNullable<typeof page> => Boolean(page));
});
const hostsPage = computed(() =>
  section.value?.pages.find((candidate) => candidate.id === "hosts"),
);

/** Host marks. The row shows where the primitive deploys, not which driver it uses. */
const hostIcons = new Map([
  ["cloudflare", "i-simple-icons-cloudflare"],
  ["vercel", "i-simple-icons-vercel"],
  ["netlify", "i-simple-icons-netlify"],
  ["deno", "i-simple-icons-deno"],
  ["node", "i-simple-icons-nodedotjs"],
  ["docker", "i-simple-icons-docker"],
  ["nuxt", "i-simple-icons-nuxt"],
  ["nitro", "i-lucide-server"],
]);
const hostOrder = ["node", "docker", "cloudflare", "vercel", "netlify", "deno", "nuxt", "nitro"];

const hosts = computed(() =>
  (props.hosts ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, icon: hostIcons.get(name.toLowerCase()) ?? "i-lucide-server" }))
    .sort((left, right) => {
      const leftOrder = hostOrder.indexOf(left.name.toLowerCase());
      const rightOrder = hostOrder.indexOf(right.name.toLowerCase());
      return (
        (leftOrder < 0 ? hostOrder.length : leftOrder) -
        (rightOrder < 0 ? hostOrder.length : rightOrder)
      );
    }),
);
const channelIcons = new Map([
  ["web chat", "i-lucide-messages-square"],
  ["http", "i-lucide-globe"],
  ["slack", "i-simple-icons-slack"],
  ["discord", "i-simple-icons-discord"],
  ["telegram", "i-simple-icons-telegram"],
  ["teams", "i-lucide-users"],
  ["github", "i-simple-icons-github"],
  ["gitlab", "i-simple-icons-gitlab"],
  ["forgejo", "i-simple-icons-forgejo"],
  ["gmail", "i-simple-icons-gmail"],
]);
const channelItems = computed(() =>
  (props.channels ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, icon: channelIcons.get(name.toLowerCase()) ?? "i-lucide-plug" })),
);
const channelPath = computed(() =>
  props.channelMode === "custom" ? "/docs/channels/get-started" : "/docs/agents/channels",
);
</script>

<template>
  <header class="not-prose vh-hero">
    <div class="vh-hero-copy">
      <h1 class="vh-hero-title">{{ page?.sourceTitle || page?.title }}</h1>
      <p class="vh-hero-tagline">{{ tagline || page?.description }}</p>

      <div class="vh-hero-actions">
        <NuxtLink v-if="getStarted" :to="getStarted.path" class="vh-hero-cta group">
          {{ getStarted.title }}
          <UIcon
            name="i-lucide-arrow-right"
            class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </NuxtLink>
        <NuxtLink v-if="secondaryPage" :to="secondaryPage.path" class="vh-hero-secondary">
          {{ secondaryPage.title }}
        </NuxtLink>
      </div>

      <nav v-if="heroPages.length" class="vh-hero-pages" aria-label="Product pages">
        <NuxtLink v-for="heroPage in heroPages" :key="heroPage.path" :to="heroPage.path">
          {{ heroPage.title }}
        </NuxtLink>
      </nav>

      <div v-if="channelItems.length" class="vh-hero-hosts">
        <span class="vh-hero-hosts-label">{{
          channelMode === "custom" ? "Example connectors" : "Built-in channels"
        }}</span>
        <ul class="vh-hero-hosts-list" aria-label="Channels">
          <li v-for="channel in channelItems" :key="channel.name" class="vh-hero-host">
            <NuxtLink :to="channelPath" class="vh-hero-host-link">
              <UIcon :name="channel.icon" class="size-4 shrink-0" aria-hidden="true" />
              <span>{{ channel.name }}</span>
            </NuxtLink>
          </li>
        </ul>
        <p v-if="channelMode === 'custom'" class="vh-hero-channel-note">
          You write each connector. Use
          <NuxtLink to="/docs/agents/channels">Agent Channels</NuxtLink> for built-in chat
          integrations.
        </p>
      </div>

      <div v-if="hosts.length" class="vh-hero-hosts">
        <span class="vh-hero-hosts-label">Deploys on</span>
        <ul class="vh-hero-hosts-list" aria-label="Hosts">
          <li v-for="host in hosts" :key="host.name" class="vh-hero-host">
            <NuxtLink v-if="hostsPage" :to="hostsPage.path" class="vh-hero-host-link">
              <UIcon :name="host.icon" class="size-4 shrink-0" aria-hidden="true" />
              <span>{{ host.name }}</span>
            </NuxtLink>
            <span v-else class="vh-hero-host-link">
              <UIcon :name="host.icon" class="size-4 shrink-0" aria-hidden="true" />
              <span>{{ host.name }}</span>
            </span>
          </li>
        </ul>
      </div>
    </div>

    <div class="vh-hero-panel">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.vh-hero {
  display: grid;
  gap: 2.5rem;
  align-items: start;
  padding: 2.5rem 0 1rem;
}

@media (min-width: 64rem) {
  .vh-hero {
    grid-template-columns: minmax(20rem, 0.7fr) minmax(0, 1.3fr);
    gap: 4rem;
    padding: 4rem 0 2rem;
  }
}

.vh-hero-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: clamp(3rem, 5vw, 4.5rem);
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1;
  text-wrap: balance;
}

.vh-hero-tagline {
  max-width: 42ch;
  margin: 1.5rem 0 0;
  color: var(--ui-text-muted);
  font-size: 1.125rem;
  line-height: 1.75rem;
  text-wrap: pretty;
}

.vh-hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.25rem;
  margin-top: 2rem;
}

.vh-hero-cta {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  gap: 0.375rem;
  background: var(--ui-text-highlighted);
  padding: 0 1rem;
  color: var(--ui-bg);
  font-size: 0.875rem;
  font-weight: 500;
  transition: transform 120ms ease;
}

.vh-hero-cta:active {
  transform: scale(0.96);
}

.vh-hero-cta:hover .landing-cta-arrow {
  transform: translateX(0.25rem);
}

.vh-hero-secondary {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  font-weight: 500;
  transition: color 150ms ease;
}

.vh-hero-secondary:hover {
  color: var(--ui-text-highlighted);
}

.vh-hero-pages {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  margin-top: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  line-height: 1.25rem;
}

.vh-hero-pages a:hover {
  color: var(--ui-text-highlighted);
}

.vh-hero-hosts {
  margin-top: 2.25rem;
}

.vh-hero-hosts-label {
  display: block;
  margin-bottom: 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  font-weight: 500;
}

.vh-hero-channel-note {
  margin: 0.75rem 0 0;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.vh-hero-channel-note a {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.vh-hero-hosts-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.vh-hero-host {
  display: inline-flex;
  align-items: center;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
}

.vh-hero-host-link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.vh-hero-host-link:hover {
  color: var(--ui-text-highlighted);
}

/*
 * The slot is a prose code group. Its tab list becomes a file list on the left and the active
 * code fills a fixed-height panel on the right, so switching files does not move the page.
 */
.vh-hero-panel {
  min-width: 0;
}

.vh-hero-panel :deep(> *) {
  margin: 0;
}

.vh-hero-panel :deep(> div:has(> [role="tablist"])) {
  display: grid;
  height: 28rem;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-bg);
}

@media (min-width: 40rem) {
  .vh-hero-panel :deep(> div:has(> [role="tablist"])) {
    grid-template-columns: 11rem minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
}

/* The tab list is a file list: one file per row, long paths cut from the start. */
.vh-hero-panel :deep([role="tablist"]) {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  counter-reset: demo-file;
  min-width: 0;
  border-right: 1px solid var(--ui-border);
  border-bottom: 0;
  background: var(--ui-bg-muted);
  padding: 0.5rem 0;
}

.vh-hero-panel :deep(> div:has(> [role="tablist"]) > [role="tablist"]) {
  grid-area: 1 / 1;
}

.vh-hero-panel :deep(> div:has(> [role="tablist"]) > [role="tabpanel"]) {
  grid-area: 1 / 2;
}

.vh-hero-panel :deep(> div:has(> [role="tablist"]) > [role="tabpanel"][data-state="inactive"]),
.vh-hero-panel :deep(> div:has(> [role="tablist"]) > [role="tabpanel"][hidden]) {
  display: block;
  visibility: hidden;
}

.vh-hero-panel :deep([role="tab"]) {
  display: flex;
  counter-increment: demo-file;
  gap: 0.625rem;
  width: 100%;
  min-width: 0;
  justify-content: flex-start;
  overflow: hidden;
  border: 0;
  border-left: 2px solid transparent;
  border-radius: 0;
  padding: 0.375rem 0.875rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-align: left;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.vh-hero-panel :deep([role="tab"])::before {
  content: counter(demo-file) ".";
  color: var(--ui-text-dimmed);
  font-variant-numeric: tabular-nums;
}

.vh-hero-panel :deep([role="tab"] > .iconify) {
  filter: grayscale(1);
  opacity: 0.7;
}

.vh-hero-panel :deep([role="tab"][data-state="active"]),
.vh-hero-panel :deep([role="tab"][aria-selected="true"]) {
  border-left-color: var(--ui-text-highlighted);
  background: color-mix(in srgb, var(--ui-text-highlighted) 6%, transparent);
  color: var(--ui-text-highlighted);
}

.vh-hero-panel :deep([role="tabpanel"]) {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.vh-hero-panel :deep([role="tabpanel"] > div),
.vh-hero-panel :deep([role="tabpanel"] pre) {
  border: 0;
  border-radius: 0;
  margin: 0;
}

.vh-hero-panel :deep(pre) {
  min-height: 100%;
  white-space: pre;
  font-size: 0.8125rem;
  line-height: 1.75;
}

@media (max-width: 39.99rem) {
  .vh-hero-panel :deep(> div:has(> [role="tablist"]) > [role="tabpanel"]) {
    grid-area: 2 / 1;
  }

  .vh-hero-panel :deep([role="tablist"]) {
    flex-direction: row;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--ui-border);
  }

  .vh-hero-panel :deep([role="tab"]) {
    width: auto;
    flex: 0 0 auto;
  }
}

.vh-agent-demo :deep(.playground-stage) {
  border-radius: var(--ui-radius);
  box-shadow: none;
}

@media (prefers-reduced-motion: reduce) {
  .vh-hero-cta {
    transition: none;
  }
}
</style>
