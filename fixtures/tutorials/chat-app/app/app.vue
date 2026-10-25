<script setup lang="ts">
import type { Thread, ThreadSummary } from "../shared/chat";

const password = ref("");
const notice = ref("");
const busy = ref(false);
const loading = ref(false);
const selected = ref<Thread>();
const chats = ref<ThreadSummary[]>([]);
const { data: session, refresh: refreshSession } = await useFetch("/api/session");

async function loadList() { chats.value = await $fetch<ThreadSummary[]>("/api/chats"); }

async function choose(id: string) {
  if (busy.value || loading.value) return;
  loading.value = true;
  try {
    selected.value = await $fetch<Thread>(`/api/chats/${id}`);
    localStorage.setItem("chat-id", id);
  } catch { notice.value = "Could not open this chat."; }
  finally { loading.value = false; }
}

async function createChat() {
  if (busy.value || loading.value) return;
  loading.value = true;
  try {
    const thread = await $fetch<Thread>("/api/chats", { method: "POST" });
    selected.value = thread;
    localStorage.setItem("chat-id", thread.id);
    await loadList();
  } catch { notice.value = "Could not create a chat. Try again or delete an old chat."; }
  finally { loading.value = false; }
}

async function restore() {
  try {
    await loadList();
    const id = localStorage.getItem("chat-id");
    const previous = chats.value.find(chat => chat.id === id) || chats.value[0];
    if (previous) await choose(previous.id);
  } catch { notice.value = "Could not load chats. Sign in again."; }
}

async function signIn() {
  try {
    await $fetch("/api/session", { method: "POST", body: { password: password.value } });
    password.value = "";
    notice.value = "";
    await refreshSession();
    await restore();
  } catch { notice.value = "Sign-in failed. Check the password and server configuration, or wait a minute."; }
}

async function signOut() {
  await $fetch("/api/session", { method: "DELETE" });
  selected.value = undefined;
  chats.value = [];
  localStorage.removeItem("chat-id");
  await refreshSession();
}

async function removeChat() {
  if (!selected.value || busy.value) return;
  if (!window.confirm("Delete this chat and its saved messages?")) return;
  try {
    await $fetch(`/api/chats/${selected.value.id}`, { method: "DELETE" });
    selected.value = undefined;
    localStorage.removeItem("chat-id");
    await loadList();
    if (chats.value[0]) await choose(chats.value[0].id);
  } catch { notice.value = "Could not delete the chat. Wait for its reply to finish."; }
}

onMounted(() => { if (session.value?.signedIn) void restore(); });
</script>

<template>
  <UApp>
    <main v-if="!session?.signedIn" class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
      <h1 class="text-2xl font-semibold">Your chat workspace</h1>
      <p class="text-sm text-muted">Sign in with the owner password from your server's .env file.</p>
      <form class="flex flex-col gap-3" @submit.prevent="signIn">
        <label for="password">Owner password</label>
        <UInput id="password" v-model="password" type="password" autocomplete="current-password" required />
        <UButton type="submit" class="justify-center">Sign in</UButton>
      </form>
      <p v-if="notice" role="alert">{{ notice }}</p>
    </main>
    <main v-else class="flex h-dvh flex-col bg-default md:flex-row">
      <aside class="flex max-h-72 shrink-0 flex-col gap-3 border-b border-default p-4 md:max-h-none md:w-64 md:border-r md:border-b-0">
        <h1 class="text-lg font-semibold">Your chats</h1>
        <p class="text-xs text-muted">{{ session.mode === 'offline' ? 'Offline practice. No model calls.' : 'AI model. Requests may incur charges.' }}</p>
        <UButton :disabled="busy || loading" @click="createChat">New chat</UButton>
        <nav aria-label="Saved chats" class="flex-1 overflow-y-auto">
          <button v-for="chat in chats" :key="chat.id" type="button"
            :aria-current="selected?.id === chat.id ? 'page' : undefined"
            :disabled="busy || loading"
            class="block w-full truncate rounded px-2 py-2 text-left text-sm hover:bg-elevated focus-visible:outline-2 aria-[current=page]:bg-elevated disabled:opacity-50"
            @click="choose(chat.id)">{{ chat.title }}</button>
        </nav>
        <div class="flex gap-2">
          <UButton variant="ghost" :disabled="busy || !selected" @click="removeChat">Delete chat</UButton>
          <UButton variant="ghost" :disabled="busy" @click="signOut">Sign out</UButton>
        </div>
      </aside>
      <section aria-label="Conversation" class="flex min-h-0 min-w-0 flex-1 flex-col">
        <p v-if="notice" role="alert" class="p-4">{{ notice }}</p>
        <p v-if="loading" role="status" class="p-4">Loading chat...</p>
        <ChatPane v-if="selected" :key="selected.id" :thread="selected" :blocked="loading" @saved="loadList" @busy="busy = $event" />
        <div v-else class="m-auto max-w-sm p-6 text-center">
          <h2 class="text-xl font-medium">Start a conversation</h2>
          <p class="mt-2 text-sm text-muted">Choose New chat, then send Hello. Completed replies stay here after a restart.</p>
        </div>
      </section>
    </main>
  </UApp>
</template>
