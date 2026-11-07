<script setup lang="ts">
// `::product-hero` opens a product landing page. The copy comes from the page frontmatter and the
// section manifest. The default slot renders in the right column: a `::product-files` file tree, a
// `::product-screenshot` of the Console, or an animated component such as `::cms-console-demo`.
// The only action is Get started. The sidebar lists the other product pages.

const props = defineProps<{
  /** One sentence of 20 words or fewer, shown instead of the frontmatter description. */
  tagline?: string;
  /** Comma-separated hosts the primitive deploys on, as the product's hosts page lists them. */
  hosts?: string;
  /** Built-in inbound Agent Channels, or examples of application-owned outbound connectors. */
  channels?: string;
  channelMode?: "builtin" | "custom";
}>();

const found = useDocsPage();
const page = computed(() => found.value?.page ?? null);
const section = useDocsSection();
// Pages of the section other than its Overview, in sidebar order.
const subpages = computed(() => section.value?.pages.filter(candidate => candidate.navigation && candidate.id !== "index") ?? []);
const getStarted = computed(
  () => subpages.value.find((candidate) => candidate.id === "get-started") ?? subpages.value[0],
);
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
      </div>

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
  grid-template-columns: minmax(0, 1fr);
  gap: 2.5rem;
  align-items: start;
  padding: 2.5rem 0 1rem;
}

@media (min-width: 64rem) {
  .vh-hero {
    padding: 4rem 0 2rem;
  }
}

/*
 * The example goes beside the copy, at the top right, once it fits next to the docs sidebar. A screenshot or an
 * animation fits from 80rem. Code needs about 70 characters beside its file tabs, so a hero with files waits for 90rem.
 */
@media (min-width: 80rem) {
  .vh-hero:not(:has(.vh-files)) {
    grid-template-columns: minmax(17rem, 0.7fr) minmax(0, 1.3fr);
    gap: 3rem;
  }
}

@media (min-width: 90rem) {
  .vh-hero {
    grid-template-columns: minmax(17rem, 0.7fr) minmax(0, 1.3fr);
    gap: 3rem;
  }
}

/* The title scales with its column, not the viewport, so a long product name never reaches the code panel. */
.vh-hero-copy {
  min-width: 0;
  container-type: inline-size;
}

.vh-hero-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: clamp(2.5rem, 17cqi, 4.5rem);
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

/* The slot components style themselves. */
.vh-hero-panel {
  min-width: 0;
}

.vh-hero-panel :deep(> *) {
  margin: 0;
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
