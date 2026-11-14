<script setup lang="ts">
import { PlaygroundContainer, type PlaygroundContainerTemplate } from "@vite-hub/ui/workspace";
import { fetchSnapshot } from "@vite-hub/web-container";
import { defineConnect } from "@vite-hub/web-container/connect";
import { playgroundTemplates } from "#build/playground-templates.mjs";

// A free-form app in the browser: the tutorial workspace without a lesson. The page sends the same cross-origin
// isolation headers as `/learn`, so links to and from it load a new document.
// The docs sidebar starts as a narrow strip, so the workspace gets the width, and the reader can open it.
definePageMeta({ layout: "docs", sidebar: "collapsed" });

const title = "Playground";
const description = "Edit and run a ViteHub app in your browser. Start from a template, then share a link or download the files.";
useSeoMeta({ title, ogTitle: title, description, ogDescription: description });

const route = useRoute();
const router = useRouter();
const fallback = playgroundTemplates[0]!;

// Templates with the same dependencies share one snapshot function, so the container switches between them without a
// new boot. The tutorial with those dependencies uses the same cache name, so the browser keeps one copy of the parts.
const snapshots = new Map<string, () => Promise<Uint8Array>>();
const templates: PlaygroundContainerTemplate[] = playgroundTemplates.map(({ snapshot: prebuilt, snapshotOf, ...template }) => {
  if (prebuilt && !snapshots.has(snapshotOf)) {
    snapshots.set(snapshotOf, () => fetchSnapshot(prebuilt.parts, { cache: `vitehub-tutorial-${snapshotOf}`, sha256: prebuilt.sha256 }));
  }
  return { ...template, snapshot: snapshots.get(snapshotOf) };
});

// Tokens stay in this tab (sessionStorage). They reach the app only as environment variables of the dev server.
const connect = defineConnect({ anthropic: true, github: true, netlify: true, openai: true, vercel: true });
const open = ref(false);

/** The address keeps the template that is open. A share link no longer matches the files, so its hash goes. */
function keep(id: string) {
  void router.replace({ query: { ...route.query, template: id === fallback.id ? undefined : id }, hash: "" });
}
</script>

<template>
  <div class="vh-playground" :class="{ 'has-workspace': open }">
    <!-- The fixtures run `vite --port 3000`. Nitro starts dev workers on other ports first, and they are not the app. -->
    <PlaygroundContainer
      v-model:open="open"
      :templates="templates"
      :template="typeof route.query.template === 'string' ? route.query.template : undefined"
      label="playground"
      name="vitehub"
      :port="3000"
      :connect="connect"
      @update:template="keep"
    >
      <template #intro>
        <h1 class="text-balance text-3xl font-semibold text-highlighted">{{ title }}</h1>
        <p class="mt-3 text-muted">{{ description }}</p>
      </template>

      <template #fallback>
        <h2 class="mt-10 text-lg font-semibold text-highlighted">Templates</h2>
        <ul class="vh-playground-list">
          <li v-for="template in playgroundTemplates" :key="template.id">
            <!-- A new document boots the template, as a link from another page does. -->
            <a :href="template.id === fallback.id ? '/playground' : `/playground?template=${template.id}`" class="font-medium text-highlighted">{{ template.label }}</a>
            <span class="text-muted">: {{ template.description }}</span>
          </li>
        </ul>

        <h2 class="mt-10 text-lg font-semibold text-highlighted">How it works</h2>
        <ul class="vh-playground-list text-muted">
          <li>The app runs in a WebContainer, a Node.js runtime inside the browser tab. The first start downloads the dependencies of the app.</li>
          <li>A share link keeps your files in the part of the URL after <code>#</code>, which the browser does not send to a server.</li>
          <li>Download saves the files of the app as a zip, so you can run it on your machine.</li>
        </ul>
      </template>
    </PlaygroundContainer>
  </div>
</template>

<style scoped>
/* The page is as tall as the viewport under the header, so a desktop shows the workspace start in place. */
.vh-playground {
  display: flex;
  min-height: calc(100dvh - var(--ui-header-height));
  flex-direction: column;
}

.vh-playground.has-workspace {
  height: calc(100dvh - var(--ui-header-height));
}

.vh-playground > :deep(.vh-pc) {
  flex: 1 1 0;
}

.vh-playground :deep(.vh-pc-gate-content) {
  width: 100%;
  max-width: calc(65ch + 2rem);
  margin-inline: auto;
  padding: 2.5rem 1rem 4rem;
}

.vh-playground-list {
  margin-top: 0.75rem;
  display: grid;
  gap: 0.5rem;
  padding-inline-start: 1.25rem;
  list-style: disc;
}
</style>
