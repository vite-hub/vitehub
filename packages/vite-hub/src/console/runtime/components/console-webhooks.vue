<script setup lang="ts">
import { Status } from "@vite-hub/ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { ConsoleContributedSection } from "../definitions";
import { consoleDateTime } from "../client/format";
import { isConsoleSectionReadOnly } from "../client/read-only";
import { queryChoice, querySelection, useConsoleQuery } from "../client/route-query";
import { useConsoleToast } from "../client/toast";
import {
  canRedeliverWebhook,
  changeWebhookDelivery,
  readPendingWebhookDeliveries,
  readWebhookDeliveries,
  readWebhookDelivery,
  readWebhooks,
  testWebhook,
  webhookAttempts,
  webhookCountdown,
  webhookDebounceLabel,
  webhookEventCount,
  webhookLastResult,
  webhookLogFilters,
  webhookStateStatus,
} from "../client/webhooks";
import type { ConsoleWebhook, ConsoleWebhookDelivery, ConsoleWebhookLogFilter } from "../client/webhooks";
import { consoleDocsBase } from "../sections";
import ConsoleCodeText from "./console-code-text.vue";
import ConsoleConfirm from "./console-confirm.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleSection from "./console-section.vue";
import ConsoleState from "./console-state.vue";

/**
 * The Webhooks section: each webhook of `server/webhooks/`, the debounce timers that wait now, and the delivery log.
 * Every list and button calls a `webhooks.*` operation as the Console user. The page names the URL and secret variables
 * and shows the URL host, never the URL or the secret.
 */
const props = defineProps<{
  definitionsBase: string;
  details: ConsoleContributedSection;
  sectionsBase: string;
}>();

// The rail's Search button and Cmd+K open the search of the page. Its API routes sit next to the sections route.
const apiBase = props.sectionsBase.replace(/\/sections$/, "");
// The log filter and the open delivery live in the URL, so a reload or a shared link opens the same view.
const { delivery: openId, state: filter } = useConsoleQuery({
  delivery: querySelection(),
  state: queryChoice(webhookLogFilters, "all", { history: "replace" }),
});

const toast = useConsoleToast();
const readOnly = ref(false);

const webhooks = ref<ConsoleWebhook[]>([]);
const pending = ref<ConsoleWebhookDelivery[]>([]);
const deliveries = ref<ConsoleWebhookDelivery[]>([]);
const loading = ref(true);
const error = ref<unknown>();
const pendingError = ref<unknown>();
const deliveriesError = ref<unknown>();
const deliveriesLoading = ref(true);
let request: AbortController | undefined;
let logRequest: AbortController | undefined;

/** Loads the webhooks and the pending timers, then the log. A failed list shows its error in place of that list. */
async function load(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  const [listed, waiting] = await Promise.allSettled([readWebhooks(controller.signal), readPendingWebhookDeliveries(controller.signal), loadLog()]);
  if (controller.signal.aborted) return;
  if (listed.status === "fulfilled") {
    webhooks.value = listed.value;
    error.value = undefined;
  } else error.value = listed.reason;
  if (waiting.status === "fulfilled") {
    pending.value = waiting.value;
    pendingError.value = undefined;
  } else {
    pending.value = [];
    pendingError.value = waiting.reason;
  }
  loading.value = false;
}

async function loadLog(): Promise<void> {
  logRequest?.abort();
  const controller = new AbortController();
  logRequest = controller;
  deliveriesLoading.value = true;
  try {
    const next = await readWebhookDeliveries(filter.value, controller.signal);
    if (controller.signal.aborted) return;
    deliveries.value = next;
    deliveriesError.value = undefined;
  } catch (cause) {
    if (controller.signal.aborted) return;
    deliveries.value = [];
    deliveriesError.value = cause;
  } finally {
    if (logRequest === controller) deliveriesLoading.value = false;
  }
}

watch(filter, () => void loadLog());

// One clock for the countdowns. It ticks each second while a timer waits.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let dueReload: ReturnType<typeof setTimeout> | undefined;
watch(() => pending.value.length > 0, (waiting) => {
  if (clock) clearInterval(clock);
  clock = undefined;
  now.value = Date.now();
  if (waiting) clock = setInterval(() => (now.value = Date.now()), 1_000);
}, { immediate: true });

/** The next time the lists may change on their own: when a timer is due, or soon while a delivery is due or sending. */
const nextChange = computed(() => {
  const active = [...pending.value, ...deliveries.value].filter(entry => entry.state === "pending" || entry.state === "sending");
  return active.reduce<number | undefined>((soonest, entry) => {
    const at = entry.state === "sending" ? 0 : entry.dueAt;
    return soonest === undefined || at < soonest ? at : soonest;
  }, undefined);
});
// The lists load again a few seconds after the next change, and keep loading while a delivery stays due or sending,
// so a slow receiver or a late Queue still ends in its final state.
watch([nextChange, loading, deliveriesLoading], ([at, listsLoading, logLoading]) => {
  if (dueReload) clearTimeout(dueReload);
  dueReload = undefined;
  if (at === undefined || listsLoading || logLoading) return;
  dueReload = setTimeout(() => void load(), Math.min(Math.max(0, at - Date.now()) + 3_000, 2 ** 31 - 1));
});

const filterItems = webhookLogFilters.map(value => ({ label: value === "all" ? "All" : webhookStateStatus(value).label, value }));
const filterLabel = computed(() => filterItems.find(item => item.value === filter.value)?.label.toLowerCase() ?? "");

function chooseFilter(value: string | number): void {
  const next = webhookLogFilters.find(entry => entry === value);
  if (next) filter.value = next as ConsoleWebhookLogFilter;
}

const signatureLabels: Record<ConsoleWebhook["signature"], string> = { github: "GitHub signature", stripe: "Stripe signature" };

/** The URL and secret variables of a webhook, with whether this server has a value for each. */
function variables(webhook: ConsoleWebhook): Array<{ label: string, name: string, set: boolean }> {
  return [{ label: "URL", name: webhook.url, set: webhook.urlSet }, { label: "Secret", name: webhook.secret, set: webhook.secretSet }];
}

const envLink = (name: string) => ({ name: "vitehub-console-env", query: { q: name } });
const isoTime = (value: number) => new Date(value).toISOString();

// A row action runs its operation, then the lists load again. The row stays disabled until then.
const busy = ref(new Set<string>());
async function run(key: string, label: string, action: () => Promise<unknown>): Promise<void> {
  if (busy.value.has(key)) return;
  busy.value = new Set([...busy.value, key]);
  try {
    await action();
    await load();
  } catch (cause) {
    toast.error(cause instanceof Error && cause.message ? cause.message : `Couldn't ${label}. Try again.`);
  } finally {
    const next = new Set(busy.value);
    next.delete(key);
    busy.value = next;
  }
}

const sendTest = (webhook: ConsoleWebhook) => run(`test:${webhook.name}`, "send the test", () => testWebhook(webhook.name));
const sendNow = (entry: ConsoleWebhookDelivery) => run(entry.id, "send it now", () => changeWebhookDelivery("flush", entry.id));
const redeliver = (entry: ConsoleWebhookDelivery) => run(entry.id, "redeliver", () => changeWebhookDelivery("redeliver", entry.id));

// Cancel drops the collected events, so it asks first.
const cancelling = ref<ConsoleWebhookDelivery>();
const cancelOpen = computed({ get: () => Boolean(cancelling.value), set: (open) => { if (!open) cancelling.value = undefined; } });
function confirmCancel(): void {
  const entry = cancelling.value;
  cancelling.value = undefined;
  if (entry) void run(entry.id, "cancel", () => changeWebhookDelivery("cancel", entry.id));
}

// The detail panel reads the delivery with its body through `webhooks.get`.
const opened = ref<ConsoleWebhookDelivery>();
const openedError = ref<unknown>();
let openRequest: AbortController | undefined;
async function loadOpened(): Promise<void> {
  openRequest?.abort();
  const id = openId.value;
  opened.value = undefined;
  openedError.value = undefined;
  if (!id) return;
  const controller = new AbortController();
  openRequest = controller;
  try {
    const value = await readWebhookDelivery(id, controller.signal);
    if (!controller.signal.aborted) opened.value = value;
  } catch (cause) {
    if (!controller.signal.aborted) openedError.value = cause;
  }
}
watch(openId, () => void loadOpened(), { immediate: true });
const detailOpen = computed({ get: () => Boolean(openId.value), set: (open) => { if (!open) openId.value = undefined; } });
const openedBody = computed(() => opened.value === undefined ? "" : JSON.stringify(opened.value.body, null, 2));

onMounted(() => {
  void load();
  void isConsoleSectionReadOnly(props.sectionsBase, props.details.id).then((value) => { readOnly.value = value; });
});
onBeforeUnmount(() => {
  request?.abort();
  logRequest?.abort();
  openRequest?.abort();
  if (clock) clearInterval(clock);
  if (dueReload) clearTimeout(dueReload);
});
</script>

<template>
  <ConsoleSearch :agents-base="`${apiBase}/agents`" :definitions-base="definitionsBase" :kv-base="`${apiBase}/kv`" :search-base="`${apiBase}/search`" :sections-base="sectionsBase" />
  <UDashboardPanel :id="`console-${details.id}`">
    <template #header>
      <ConsolePageHeader :title="details.label" :toggle="false">
        <template #right>
          <UTooltip text="Refresh">
            <UButton aria-label="Refresh" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :loading="loading" @click="load" />
          </UTooltip>
        </template>
      </ConsolePageHeader>
    </template>
    <template #body>
      <div class="flex flex-1 flex-col">
        <ConsoleState v-if="error" :error="error" title="Couldn't load the webhooks" :retry="load" />
        <div v-else-if="loading" class="mx-auto grid w-full max-w-3xl gap-3 p-6" aria-busy="true">
          <USkeleton class="h-5 w-40" />
          <USkeleton v-for="index in 3" :key="index" class="h-14 w-full" />
        </div>
        <ConsoleState
          v-else-if="!webhooks.length"
          icon="i-vitehub-webhooks"
          title="No webhooks yet"
          description="Add `server/webhooks/<name>.ts` that default-exports `defineWebhook({ url, secret })`."
          :docs="`${consoleDocsBase}/webhooks/get-started`"
        />
        <div v-else class="mx-auto grid w-full max-w-3xl gap-8 p-6">
          <ConsoleSection title="Endpoints" :count="webhooks.length">
            <ul class="divide-y divide-default rounded-lg border border-default">
              <li v-for="webhook in webhooks" :key="webhook.name" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                <span class="grid min-w-0 flex-1 basis-56 gap-0.5">
                  <span class="truncate text-[13px] font-medium text-highlighted">{{ webhook.name }}</span>
                  <span class="truncate text-xs text-dimmed">
                    <span :class="webhook.host ? 'font-mono text-muted' : 'text-warning'">{{ webhook.host ?? "No URL" }}</span>
                    · {{ signatureLabels[webhook.signature] }} · {{ webhookDebounceLabel(webhook.debounceMs) }}
                  </span>
                  <span class="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs">
                    <span v-for="variable in variables(webhook)" :key="variable.label" class="inline-flex min-w-0 items-center gap-1.5">
                      <span class="text-dimmed">{{ variable.label }}</span>
                      <RouterLink
                        :to="envLink(variable.name)"
                        class="truncate rounded-sm font-mono text-muted underline-offset-2 hover:text-highlighted hover:underline"
                        :aria-label="`${variable.name}, ${variable.set ? 'set' : 'not set'}. Open in Env`"
                      >{{ variable.name }}</RouterLink>
                      <span v-if="!variable.set" class="shrink-0 text-warning">not set</span>
                    </span>
                  </span>
                </span>
                <UTooltip v-if="!readOnly" :text="webhook.urlSet && webhook.secretSet ? 'Send a test delivery now, without the debounce' : 'Set the URL and secret in Env first'">
                  <UButton
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    icon="i-lucide-send"
                    label="Send test"
                    :aria-label="`Send a test to ${webhook.name}`"
                    :disabled="!webhook.urlSet || !webhook.secretSet"
                    :loading="busy.has(`test:${webhook.name}`)"
                    @click="sendTest(webhook)"
                  />
                </UTooltip>
              </li>
            </ul>
          </ConsoleSection>

          <ConsoleSection title="Pending" :count="pendingError ? undefined : pending.length" description="Debounce timers that wait now. Each send moves its timer.">
            <ConsoleState v-if="pendingError" compact :error="pendingError" title="Couldn't load the pending timers" :retry="load" />
            <ul v-else-if="pending.length" class="divide-y divide-default rounded-lg border border-default">
              <li v-for="entry in pending" :key="entry.id" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                <span class="grid min-w-0 flex-1 basis-56 gap-0.5">
                  <span class="truncate text-[13px] font-medium text-highlighted">{{ entry.event }}</span>
                  <span class="truncate text-xs text-dimmed">{{ entry.webhook }} · {{ webhookEventCount(entry.count) }}<template v-if="entry.key"> · <span class="font-mono">{{ entry.key }}</span></template></span>
                </span>
                <span class="ms-auto shrink-0 text-xs tabular-nums text-muted" :title="consoleDateTime(entry.dueAt)">{{ webhookCountdown(entry.dueAt, now) }}</span>
                <template v-if="!readOnly">
                  <UButton size="xs" variant="ghost" color="neutral" label="Send now" :aria-label="`Send ${entry.event} to ${entry.webhook} now`" :disabled="busy.has(entry.id)" @click="sendNow(entry)" />
                  <UButton size="xs" variant="ghost" color="neutral" label="Cancel" :aria-label="`Cancel ${entry.event} to ${entry.webhook}`" :disabled="busy.has(entry.id)" @click="cancelling = entry" />
                </template>
              </li>
            </ul>
            <p v-else class="rounded-lg border border-dashed border-default px-3 py-4 text-center text-xs text-dimmed">No timers wait now. A send to a webhook with a debounce starts one.</p>
          </ConsoleSection>

          <ConsoleSection title="Deliveries" :count="deliveriesError ? undefined : deliveries.length" description="The newest 100, newest first.">
            <template #actions>
              <UTabs :model-value="filter" :items="filterItems" :content="false" size="xs" class="w-max" aria-label="Delivery state" @update:model-value="chooseFilter" />
            </template>
            <ConsoleState v-if="deliveriesError" compact :error="deliveriesError" title="Couldn't load the deliveries" :retry="loadLog" />
            <div v-else-if="deliveriesLoading && !deliveries.length" aria-busy="true">
              <USkeleton v-for="index in 3" :key="index" class="my-1 h-12 w-full" />
            </div>
            <ul v-else-if="deliveries.length" class="divide-y divide-default overflow-hidden rounded-lg border border-default">
              <li v-for="entry in deliveries" :key="entry.id" class="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 hover:bg-elevated">
                <Status class="w-20 shrink-0" :tone="webhookStateStatus(entry.state).tone" :label="webhookStateStatus(entry.state).label" />
                <span class="grid min-w-0 flex-1 basis-56 gap-0.5">
                  <!-- The button overlay makes the whole row open the delivery. -->
                  <button type="button" class="truncate rounded-sm text-left text-[13px] font-medium text-highlighted after:absolute after:inset-0" @click="openId = entry.id">{{ entry.event }}</button>
                  <span class="truncate text-xs text-dimmed">{{ entry.webhook }} · {{ entry.attempts ? `${webhookAttempts(entry.attempts)} · ${webhookLastResult(entry)}` : webhookLastResult(entry) }}</span>
                </span>
                <span class="relative shrink-0 text-xs text-muted tabular-nums max-sm:hidden"><ConsoleRelativeTime :value="isoTime(entry.createdAt)" /></span>
                <UButton
                  v-if="!readOnly && canRedeliverWebhook(entry.state)"
                  class="relative ms-auto"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  label="Redeliver"
                  :aria-label="`Redeliver ${entry.event} to ${entry.webhook}`"
                  :disabled="busy.has(entry.id)"
                  @click="redeliver(entry)"
                />
              </li>
            </ul>
            <p v-else class="rounded-lg border border-dashed border-default px-3 py-4 text-center text-xs text-dimmed">
              {{ filter === "all" ? "No deliveries yet. Send a test to see one here." : `No ${filterLabel} deliveries.` }}
            </p>
          </ConsoleSection>

          <p class="text-xs text-muted"><ConsoleCodeText :text="details.view.notice" /></p>
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <ConsoleConfirm
    v-model:open="cancelOpen"
    title="Cancel this delivery?"
    :description="cancelling ? `The ${webhookEventCount(cancelling.count)} of ${cancelling.event} are never sent to ${cancelling.webhook}. Redeliver sends them later if you need them.` : undefined"
    confirm-label="Cancel delivery"
    cancel-label="Keep"
    destructive
    @confirm="confirmCancel"
  />

  <USlideover v-model:open="detailOpen" :title="opened?.event ?? 'Delivery'" :description="openId" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <ConsoleState v-if="openedError" compact :error="openedError" title="Couldn't load the delivery" :retry="loadOpened" />
      <div v-else-if="!opened" class="grid gap-2" aria-busy="true">
        <USkeleton v-for="index in 6" :key="index" class="h-4" :class="index % 2 ? 'w-2/3' : 'w-1/2'" />
      </div>
      <div v-else class="grid gap-4">
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs">
          <dt class="text-muted">State</dt>
          <dd><Status :tone="webhookStateStatus(opened.state).tone" :label="webhookStateStatus(opened.state).label" /></dd>
          <dt class="text-muted">Webhook</dt>
          <dd class="text-highlighted">{{ opened.webhook }}</dd>
          <template v-if="opened.key">
            <dt class="text-muted">Key</dt>
            <dd class="font-mono text-highlighted">{{ opened.key }}</dd>
          </template>
          <dt class="text-muted">Events</dt>
          <dd class="text-highlighted tabular-nums">{{ opened.count }}</dd>
          <dt class="text-muted">Attempts</dt>
          <dd class="text-highlighted tabular-nums">{{ opened.attempts }}</dd>
          <dt class="text-muted">Last result</dt>
          <dd class="break-words text-highlighted">{{ webhookLastResult(opened) }}</dd>
          <dt class="text-muted">Created</dt>
          <dd class="text-highlighted tabular-nums">{{ consoleDateTime(opened.createdAt) }}</dd>
          <template v-if="opened.state === 'pending'">
            <dt class="text-muted">Due</dt>
            <dd class="text-highlighted tabular-nums">{{ consoleDateTime(opened.dueAt) }}</dd>
          </template>
          <template v-if="opened.sentAt">
            <dt class="text-muted">Sent</dt>
            <dd class="text-highlighted tabular-nums">{{ consoleDateTime(opened.sentAt) }}</dd>
          </template>
        </dl>
        <section class="grid gap-1.5" aria-labelledby="webhook-delivery-body">
          <h3 id="webhook-delivery-body" class="text-xs font-medium text-highlighted">Body</h3>
          <pre class="overflow-auto rounded-md bg-elevated p-3 font-mono text-xs leading-5 text-toned"><code>{{ openedBody }}</code></pre>
        </section>
      </div>
    </template>
  </USlideover>
</template>
