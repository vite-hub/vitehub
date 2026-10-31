<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { peekConsoleRateLimit, resetConsoleRateLimit } from "../client/rate-limit";
import type { ConsoleRateLimitPeek } from "../client/rate-limit";
import { useConsoleToast } from "../client/toast";

/**
 * Live counters of one Rate Limit. The counter belongs to a key, such as a client IP or a user ID, so the page asks for
 * the key, reads it without consuming a token, and resets it on request.
 */
const props = defineProps<{
  base: string;
  /** The stable ID of `requireRateLimit()`. */
  name: string;
  /** The access may only read Rate Limits (`"rate-limits:read"`), so the page offers no reset. */
  readOnly?: boolean;
}>();

const toast = useConsoleToast();
const key = ref("");
const peeked = ref<ConsoleRateLimitPeek>();
// Inspection may redact the echoed key. Keep the successful request's identity for mutations.
const peekedKey = ref<string>();
const error = ref<string>();
const loading = ref(false);
const resetOpen = ref(false);
const resetting = ref(false);
let request: AbortController | undefined;

// A readable result must contain an active counter; an unavailable counter may still exist.
const canReset = computed(() => {
  if (props.readOnly) return false;
  const result = peeked.value;
  return result?.status === "unavailable" || (result?.status === "known" && result.counters.some(counter => counter.used > 0 || counter.resetAt !== undefined));
});

function message(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

function expiry(resetAt: number | undefined): string {
  return resetAt === undefined ? "–" : new Date(resetAt).toLocaleTimeString();
}

async function peek(): Promise<void> {
  const current = key.value;
  if (current === "" || loading.value) return;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = undefined;
  try {
    const result = await peekConsoleRateLimit(props.base, props.name, current, controller.signal);
    if (request === controller) {
      peeked.value = result;
      peekedKey.value = current;
    }
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") return;
    peeked.value = undefined;
    peekedKey.value = undefined;
    error.value = message(failure, "The Console could not read this counter.");
  } finally {
    if (request === controller) {
      request = undefined;
      loading.value = false;
    }
  }
}

async function confirmReset(): Promise<void> {
  const target = peeked.value;
  const targetKey = peekedKey.value;
  if (!target || targetKey === undefined || resetting.value) return;
  resetting.value = true;
  try {
    const result = await resetConsoleRateLimit(props.base, target.name, targetKey);
    resetOpen.value = false;
    if (result.status === "reset") toast.show({ title: "Counter reset" });
    else toast.error(result.reason ?? "The provider could not reset this counter.");
    await peek();
  } catch (failure) {
    resetOpen.value = false;
    toast.error(message(failure, "The Console could not reset this counter."));
  } finally {
    resetting.value = false;
  }
}

// A counter belongs to its Rate Limit, so another selection starts empty.
watch(() => props.name, () => {
  request?.abort();
  loading.value = false;
  peeked.value = undefined;
  peekedKey.value = undefined;
  error.value = undefined;
});
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <section class="grid gap-3" aria-label="Live counter">
    <h3 class="text-xs font-medium text-highlighted">Live counter</h3>
    <form class="flex flex-wrap items-center gap-2" @submit.prevent="peek">
      <UInput
        v-model="key"
        class="w-full sm:w-72"
        size="sm"
        placeholder="Key, for example a client IP or user ID"
        aria-label="Key to read"
        autocomplete="off"
        spellcheck="false"
      />
      <UButton type="submit" icon="i-lucide-gauge" label="Peek" size="sm" variant="outline" :disabled="key === ''" :loading="loading" />
      <UButton
        v-if="canReset"
        icon="i-lucide-rotate-ccw"
        label="Reset"
        size="sm"
        color="error"
        variant="ghost"
        @click="resetOpen = true"
      />
    </form>
    <p v-if="error" class="text-[13px] text-error" role="alert">{{ error }}</p>
    <div v-else-if="peeked" aria-live="polite" class="grid gap-2">
      <div v-if="peeked.status === 'known'" class="overflow-x-auto">
        <table class="w-full text-left text-[13px]">
          <thead>
            <tr class="border-b border-default">
              <th v-for="heading in ['Policy', 'Used', 'Remaining', 'Resets at']" :key="heading" class="h-8 whitespace-nowrap px-2 text-xs font-medium text-dimmed" scope="col">{{ heading }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="counter in peeked.counters" :key="`${counter.limit}/${counter.window}`" class="h-10 border-b border-default">
              <td class="px-2 py-1.5 tabular-nums">{{ counter.limit }} per {{ counter.window }}</td>
              <td class="px-2 py-1.5 tabular-nums">{{ counter.used }}</td>
              <td class="px-2 py-1.5 tabular-nums">{{ counter.remaining }}</td>
              <td class="px-2 py-1.5 tabular-nums">{{ expiry(counter.resetAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="text-[13px] text-muted">{{ peeked.status === "unused" ? "No counter" : peeked.status === "unsupported" ? "Counter not readable" : "Counter unknown" }}: {{ peeked.reason }}</p>
      <p v-if="peeked.status === 'known' && peeked.scope === 'process'" class="text-xs text-muted">The counter exists only in this server process.</p>
      <p class="text-xs text-dimmed">Provider: {{ peeked.provider }}</p>
    </div>

    <UModal v-model:open="resetOpen" title="Reset this counter?" :ui="{ content: 'sm:max-w-[440px]' }">
      <template #body>
        <p class="text-[13px] text-muted">
          The counter of <span class="font-mono text-xs text-highlighted">{{ peeked?.key }}</span> for <span class="font-medium">{{ name }}</span> is deleted, so the next request starts a new window.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" label="Cancel" @click="resetOpen = false" />
          <UButton color="error" label="Reset" :loading="resetting" @click="confirmReset" />
        </div>
      </template>
    </UModal>
  </section>
</template>
