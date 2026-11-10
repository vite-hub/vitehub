<script setup lang="ts">
import type { ConnectionStatusValue, SyncStatusValue } from "@vite-hub/ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

// A synthetic room. In an application, `people`, `status`, `synced`, and `history` come from useRealtimeTiptap(), and
// the carets come from RealtimeCaret in its extensions.
const people = [
  { color: "#E11D48", id: "ana", name: "Ana Ruiz" },
  { color: "#2563EB", id: "ben", name: "Ben Ito" },
  { color: "#059669", id: "cleo", name: "Cleo Park" },
];
const sentence = " The preview link goes to the pull request, so reviewers open the build without a checkout.";

const status = ref<ConnectionStatusValue>("connecting");
const synced = ref(false);
const saving = ref(false);
const typed = ref(0);
const sync = computed<SyncStatusValue>(() => (!synced.value ? "loading" : saving.value ? "synchronizing" : "synchronized"));

let typing: ReturnType<typeof setInterval> | undefined;
let saved: ReturnType<typeof setTimeout> | undefined;
let joined: ReturnType<typeof setTimeout> | undefined;

// Ben types while the room is connected. His keystrokes reach the room; nothing reaches the Workspace until a save.
function startTyping() {
  clearInterval(typing);
  typing = setInterval(() => {
    if (status.value !== "connected") return;
    if (typed.value >= sentence.length) return void clearInterval(typing);
    typed.value++;
  }, 90);
}

// In an application, `history.checkpoint()` saves; `history.pending` is true until it settles.
function save() {
  saving.value = true;
  clearTimeout(saved);
  saved = setTimeout(() => (saving.value = false), 900);
}

function drop() {
  status.value = "disconnected";
}

function reconnect() {
  status.value = "connecting";
  joined = setTimeout(() => (status.value = "connected"), 600);
}

onMounted(() => {
  joined = setTimeout(() => {
    status.value = "connected";
    synced.value = true;
    startTyping();
  }, 600);
});

onBeforeUnmount(() => {
  clearInterval(typing);
  clearTimeout(saved);
  clearTimeout(joined);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-default">
    <header class="flex flex-wrap items-center gap-3 border-b border-default px-4 py-2.5">
      <span class="text-sm font-medium text-highlighted">Release checklist</span>
      <span class="ms-auto flex items-center gap-3">
        <SyncStatus :status="sync" />
        <ConnectionStatus :status="status" />
        <AvatarStack :people="people" size="sm" variant="outline" />
      </span>
    </header>
    <article class="min-h-0 max-w-xl flex-1 overflow-auto px-4 py-6 text-sm leading-7 text-default">
      <p class="mb-3 text-base font-semibold text-highlighted">Before we ship</p>
      <p>
        The deploy runs after the build, and the
        <span class="ProseMirror-yjs-selection" style="background-color: #05966970">smoke tests</span><span class="collaboration-carets__caret" style="border-color: #059669"><span class="collaboration-carets__label" style="background-color: #059669">Cleo Park</span></span>
        must pass first.
      </p>
      <p class="mt-3">
        Every change gets a preview.{{ sentence.slice(0, typed) }}<span class="collaboration-carets__caret" style="border-color: #2563EB"><span class="collaboration-carets__label" style="background-color: #2563EB">Ben Ito</span></span>
      </p>
    </article>
    <footer class="flex gap-2 border-t border-default px-4 py-2.5">
      <UButton color="neutral" :disabled="!synced || saving || status !== 'connected'" label="Save" size="xs" @click="save" />
      <UButton v-if="status === 'connected'" color="neutral" label="Drop the connection" size="xs" variant="outline" @click="drop" />
      <UButton v-else-if="synced" color="neutral" label="Reconnect" size="xs" variant="outline" @click="reconnect" />
    </footer>
  </div>
</template>
