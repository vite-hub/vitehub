<script setup lang="ts">
import { BrowserSupportNotice } from "@vite-hub/ui/browser-support-notice";
import { checkWebContainerSupport } from "@vite-hub/web-container";
import { useMediaQuery } from "@vueuse/core";
import { CopyButton } from "@vite-hub/ui/copy-button";
import { playgroundTemplates } from "#build/playground-templates.mjs";
import PlaygroundWorkspace from "~/components/playground/PlaygroundWorkspace.vue";
import { decodePlaygroundLink, downloadZip, readPlaygroundHash } from "@vite-hub/ui/playground";

import type { PlaygroundTemplate, TutorialFiles } from "~~/modules/tutorials/steps";

// A free-form app in the browser: the tutorial workspace without a lesson. The page sends the same cross-origin
// isolation headers as `/learn`, so links to and from it load a new document.
definePageMeta({ layout: "tutorial" });

const title = "Playground";
const description = "Edit and run a ViteHub app in your browser. Start from a template, then share a link or download the files.";
useSeoMeta({ title, ogTitle: title, description, ogDescription: description });

const route = useRoute();
const router = useRouter();
const { site } = useDocsConfig();
const fallback = playgroundTemplates[0]!;
const fromQuery = () => playgroundTemplates.find(template => template.id === route.query.template) ?? fallback;

// `id` changes when the workspace must boot again, for example for a template with another snapshot.
const session = shallowRef<{ id: number, template: PlaygroundTemplate, files: TutorialFiles }>({ id: 0, template: fromQuery(), files: fromQuery().files });
const restored = ref(false);
const invalidLink = ref(false);

function boot(template: PlaygroundTemplate, files: TutorialFiles) {
  session.value = { id: session.value.id + 1, template, files };
}
let restoration = 0;
/** A `#code=…` link holds files. Loading it opens them on their template. */
async function restore() {
  const request = ++restoration;
  const code = readPlaygroundHash(location.hash);
  const decoded = code ? await decodePlaygroundLink(code, playgroundTemplates) : undefined;
  if (request !== restoration) return;
  // Every app here starts from a template, so a link without one is not for this playground.
  const shared = decoded && playgroundTemplates.find(template => template.id === decoded.template);
  invalidLink.value = !!code && !shared;
  restored.value = !!shared;
  if (shared && decoded) return boot(shared, decoded.files);
  const template = fromQuery();
  boot(template, template.files);
}
function keep(template: PlaygroundTemplate) {
  // The share link no longer matches the files, so the address keeps the template only.
  restored.value = false;
  invalidLink.value = false;
  void router.replace({ query: { ...route.query, template: template.id === fallback.id ? undefined : template.id }, hash: "" });
}
function remount(template: PlaygroundTemplate) {
  keep(template);
  boot(template, template.files);
}

// Only desktops boot the workspace on their own. Tablets boot it on a tap. Phones never boot it.
// The server cannot know the viewport, so the first render matches it and CSS picks the layout until mount.
const mounted = ref(false);
const desktopQuery = useMediaQuery("(min-width: 64rem)");
const tabletQuery = useMediaQuery("(min-width: 48rem)");
const desktop = computed(() => mounted.value && desktopQuery.value);
const tablet = computed(() => mounted.value && tabletQuery.value);
const supported = ref<boolean>();
const opened = ref(false);
const ready = ref(false);
onMounted(async () => {
  mounted.value = true;
  supported.value = checkWebContainerSupport().supported;
  await restore();
  ready.value = true;
  window.addEventListener("hashchange", restore);
});
onBeforeUnmount(() => window.removeEventListener("hashchange", restore));
const workspaceShown = computed(() => ready.value && supported.value === true && (desktop.value || (tablet.value && opened.value)));

function download() {
  downloadZip(session.value.files, `vitehub-${session.value.template.id}`);
}
</script>

<template>
  <div class="vh-playground" :class="{ 'has-workspace': workspaceShown }">
    <div v-if="restored || invalidLink" class="vh-playground-bar" role="status">
      <UIcon :name="invalidLink ? 'i-lucide-triangle-alert' : 'i-lucide-link'" class="size-4 shrink-0" aria-hidden="true" />
      <span v-if="invalidLink">This link has no files that the playground can read. It opened the {{ session.template.label }} template.</span>
      <span v-else>You opened shared files on the {{ session.template.label }} template.</span>
    </div>

    <PlaygroundWorkspace
      v-if="workspaceShown"
      :key="session.id"
      class="vh-playground-workspace"
      :templates="playgroundTemplates"
      :template="session.template"
      :files="session.files"
      @change="keep"
      @remount="remount"
    />

    <div v-else class="vh-playground-intro" :class="{ 'is-pending': !ready }">
      <h1 class="text-balance text-3xl font-semibold text-highlighted">{{ title }}</h1>
      <p class="mt-3 text-muted">{{ description }}</p>

      <BrowserSupportNotice
        v-if="supported === false && tablet"
        class="mt-6"
        :supported="false"
        description="Download the files to run the app on your machine, or open this page in Chrome, Edge, or Firefox on a desktop to edit and run it here."
      />

      <aside class="vh-playground-mobile" aria-labelledby="vh-playground-mobile-title">
        <p id="vh-playground-mobile-title" class="text-sm text-highlighted">The playground runs a ViteHub app in a desktop browser. Open this page on a desktop to edit and run the code.</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <CopyButton :value="`${site.url}${route.fullPath}`" icon="i-lucide-link" label="Copy link" variant="outline" />
          <UButton variant="outline" icon="i-lucide-download" label="Download files" @click="download" />
        </div>
      </aside>

      <div v-if="supported === false && tablet" class="mt-4">
        <UButton variant="outline" icon="i-lucide-download" label="Download files" @click="download" />
      </div>
      <div v-else-if="tablet && !desktop" class="vh-playground-open">
        <p class="text-sm text-muted">Edit and run a ViteHub app in your browser. The first start downloads the dependencies of the app.</p>
        <UButton class="mt-3" icon="i-lucide-play" label="Open playground" @click="opened = true" />
      </div>

      <h2 class="mt-10 text-lg font-semibold text-highlighted">Templates</h2>
      <ul class="vh-playground-templates">
        <li v-for="template in playgroundTemplates" :key="template.id">
          <!-- A new document boots the template, as a link from another page does. -->
          <a :href="template.id === fallback.id ? '/playground' : `/playground?template=${template.id}`" class="font-medium text-highlighted">{{ template.label }}</a>
          <span class="text-muted">: {{ template.description }}</span>
        </li>
      </ul>

      <h2 class="mt-10 text-lg font-semibold text-highlighted">How it works</h2>
      <ul class="vh-playground-templates text-muted">
        <li>The app runs in a WebContainer, a Node.js runtime inside the browser tab. The first start downloads the dependencies of the app.</li>
        <li>A share link keeps your files in the part of the URL after <code>#</code>, which the browser does not send to a server.</li>
        <li>Download saves the files of the app as a zip, so you can run it on your machine.</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.vh-playground {
  display: flex;
  flex-direction: column;
}

.vh-playground-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated);
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
}

.vh-playground-intro {
  width: 100%;
  max-width: calc(65ch + 2rem);
  margin-inline: auto;
  padding: 2.5rem 1rem 4rem;
}

/* Phones: a quiet card that points to a desktop. */
.vh-playground-mobile {
  margin-top: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  padding: 1rem;
}

.vh-playground-open {
  margin-top: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 2);
  padding: 1rem;
}

@media (min-width: 48rem) {
  .vh-playground-mobile {
    display: none;
  }
}

/* The workspace is as tall as the viewport under the header. */
.vh-playground.has-workspace {
  height: calc(100dvh - var(--ui-header-height));
}

/* Desktops boot the workspace after mount, so the intro does not flash before it. */
@media (min-width: 64rem) {
  .vh-playground-intro.is-pending {
    visibility: hidden;
  }
}

.vh-playground-templates {
  margin-top: 0.75rem;
  display: grid;
  gap: 0.5rem;
  padding-inline-start: 1.25rem;
  list-style: disc;
}

.vh-playground-workspace {
  min-height: 0;
  flex: 1 1 0;
}
</style>
