<script setup lang="ts">
import { MultiFileDiff } from "@vite-hub/ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { ConsoleRequestError } from "../client/request";
import { loadConsoleNavigation } from "../client/sections";
import { connectSetup, setupCommand, waitForSetupRestart } from "../client/setup";
import { rememberConsoleSection } from "../sections";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";

import type { SetupCatalogFeature, SetupClient, SetupFeatureState, SetupLevel, SetupMissing, SetupPlanDocument, SetupPlanRequest, SetupStatusDocument } from "../client/setup";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

/** Where the page is: picking a feature, reading a plan, applying it, waiting for the restart, or done. */
type Step = "pick" | "plan" | "apply" | "restart" | "done";

const route = ref<string>();
const readOnly = ref(true);
const client = ref<SetupClient>();
const catalog = ref<readonly SetupCatalogFeature[]>([]);
const status = ref<SetupStatusDocument>();
const loading = ref(true);
const loadError = ref<unknown>();
const selectedId = ref<string>();
const step = ref<Step>("pick");
const plan = ref<SetupPlanDocument>();
const planning = ref(false);
const result = ref<SetupPlanDocument>();
const failure = ref<SetupPlanDocument>();
const logs = ref("");
const values = ref<Record<string, string>>({});
const restartFailed = ref(false);
let events: AbortController | undefined;
/** The applied change survives the reload after a restart, so the page can say that it worked. */
const appliedKey = "vitehub:setup:applied";

const hostName = computed(() => status.value?.host.name ?? "node");
const states = computed(() => new Map((status.value?.features ?? []).map(feature => [feature.id, feature])));
const frameworkLabel = computed(() => ({ none: "None found", nuxt: "Nuxt", vite: "Vite" })[status.value?.framework ?? "none"]);
const hostSource = computed(() => ({ config: "from preset in vitehub()", default: "the default", env: "from the environment" })[status.value?.host.source ?? "default"]);

function support(feature: SetupCatalogFeature): { level: SetupLevel, detail: string, display?: string, option?: string } {
  return states.value.get(feature.id)?.support ?? feature.hosts[hostName.value] ?? { detail: "", level: "unknown" };
}

const groups = computed(() => {
  const by = (level: SetupLevel) => catalog.value.filter(feature => support(feature).level === level);
  return [
    { features: by("native"), id: "native", label: `Works on ${hostName.value}` },
    { features: by("explicit"), id: "explicit", label: "Needs an option" },
    { features: by("unsupported"), id: "unsupported", label: `Not on ${hostName.value}` },
    { features: by("unknown"), id: "unknown", label: "Host not known" },
  ].filter(group => group.features.length);
});

const selected = computed(() => catalog.value.find(feature => feature.id === selectedId.value));
const selectedState = computed<SetupFeatureState | undefined>(() => selectedId.value ? states.value.get(selectedId.value) : undefined);
const selectedSupport = computed(() => selected.value ? support(selected.value) : undefined);
const action = computed<"add" | "remove">(() => {
  const state = selectedState.value;
  // An unsupported feature can only be removed on this host; other incomplete features can be repaired.
  return state?.enabled === "on" && (state.support.level === "unsupported" || (!state.fix && !state.missingPackages.length)) ? "remove" : "add";
});

/** Option fields: the host option of an `explicit` feature, and every field that the last plan said is missing. */
const fields = computed<SetupMissing[]>(() => {
  const list: SetupMissing[] = [];
  const option = selectedSupport.value?.level === "explicit" ? selectedSupport.value.option : undefined;
  if (option && action.value === "add") list.push({ field: option });
  for (const missing of failure.value?.missing ?? []) {
    const index = list.findIndex(item => item.field === missing.field);
    if (index === -1) list.push(missing);
    else list[index] = missing;
  }
  return list;
});

const request = computed<SetupPlanRequest | undefined>(() => {
  if (!selected.value) return;
  const options = fields.value.flatMap(item => values.value[item.field]?.trim() ? [`${item.field}=${values.value[item.field]!.trim()}`] : []);
  return { action: action.value, features: [selected.value.id], ...(options.length && action.value === "add" ? { options } : {}) };
});

/** The CLI command that does what this screen shows. */
const command = computed(() => {
  if (step.value === "done" && result.value?.command) return result.value.command;
  if (plan.value?.command) return plan.value.command;
  if (failure.value?.rerun) return failure.value.rerun;
  return request.value ? setupCommand(request.value) : "vitehub status";
});

const changes = computed(() => plan.value?.changes ?? []);
const packages = computed(() => plan.value?.install?.command ?? plan.value?.uninstall?.command);
const alsoChanges = computed(() => plan.value?.implied?.length
  ? `Also turns on ${plan.value.implied.join(", ")}.`
  : plan.value?.turnedOff?.filter(id => !plan.value?.features?.includes(id)).length
    ? `Also turns off ${plan.value.turnedOff.filter(id => !plan.value?.features?.includes(id)).join(", ")}.`
    : undefined);

function stateLabel(feature: SetupCatalogFeature): { label: string, tone: "neutral" | "success" | "warning" } {
  const state = states.value.get(feature.id);
  if (state?.enabled === "on") return { label: state.reason === "implied" ? "On, implied" : "On", tone: state.missingPackages.length ? "warning" : "success" };
  if (state?.enabled === "unknown") return { label: "Unknown", tone: "warning" };
  return { label: "Off", tone: "neutral" };
}

function select(id: string): void {
  if (step.value === "apply" || step.value === "restart") return;
  selectedId.value = id;
  step.value = "pick";
  plan.value = undefined;
  failure.value = undefined;
  result.value = undefined;
  values.value = {};
}

function readApplied(): { feature: string, result?: SetupPlanDocument } | undefined {
  try {
    const value = sessionStorage.getItem(appliedKey);
    sessionStorage.removeItem(appliedKey);
    const parsed: unknown = value ? JSON.parse(value) : undefined;
    if (!parsed || typeof parsed !== "object" || !("feature" in parsed) || typeof parsed.feature !== "string") return undefined;
    // SAFETY: This page wrote the value before the reload, with the result document of the apply.
    const result = "result" in parsed ? parsed.result as SetupPlanDocument | undefined : undefined;
    return { feature: parsed.feature, result };
  }
  catch {
    return undefined;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = undefined;
  try {
    const navigation = await loadConsoleNavigation(props.sectionsBase);
    route.value = navigation?.setup;
    readOnly.value = navigation?.readOnly.includes("setup") ?? true;
    if (!route.value) throw new ConsoleRequestError(404, "This Console has no Setup endpoints. The Setup section runs only on a development server.");
    client.value = await connectSetup(route.value);
    const [catalogDocument, statusDocument] = await Promise.all([client.value.catalog(), client.value.status()]);
    catalog.value = catalogDocument.features;
    status.value = statusDocument;
    const applied = readApplied();
    if (applied) {
      selectedId.value = applied.feature;
      result.value = applied.result;
      step.value = "done";
    }
    selectedId.value ??= catalogDocument.features.find(feature => support(feature).level === "native" && states.value.get(feature.id)?.enabled !== "on")?.id;
  }
  catch (error) {
    loadError.value = error;
  }
  finally {
    loading.value = false;
  }
}

async function makePlan(): Promise<void> {
  if (!client.value || !request.value) return;
  planning.value = true;
  try {
    const document = await client.value.plan(request.value);
    if (document.error) {
      failure.value = document;
      plan.value = undefined;
      return;
    }
    failure.value = undefined;
    plan.value = document;
    step.value = "plan";
  }
  catch (error) {
    failure.value = { error: { code: "REQUEST", message: error instanceof Error ? error.message : String(error), why: "" } };
  }
  finally {
    planning.value = false;
  }
}

function openEvents(): void {
  events?.abort();
  events = new AbortController();
  void client.value?.events((event, data) => {
    if (event === "log" && data && typeof data === "object" && "text" in data) logs.value += String(data.text);
  }, events.signal).catch(() => {});
}

async function restart(): Promise<boolean> {
  step.value = "restart";
  if (!route.value || !client.value) return false;
  const next = await waitForSetupRestart(route.value, client.value.serverId);
  if (next) {
    try {
      sessionStorage.setItem(appliedKey, JSON.stringify({ action: action.value, feature: selectedId.value, result: result.value }));
    }
    catch {}
    window.location.reload();
  }
  else restartFailed.value = true;
  return Boolean(next);
}

async function apply(): Promise<void> {
  if (readOnly.value || !client.value || !plan.value?.planId) return;
  step.value = "apply";
  logs.value = "";
  openEvents();
  let document: SetupPlanDocument;
  try {
    document = await client.value.apply(plan.value.planId);
  }
  catch (error) {
    // The server can restart before it answers. A new server id means the change went in.
    if (!await restart()) {
      events?.abort();
      restartFailed.value = false;
      failure.value = { error: { code: "REQUEST", message: error instanceof Error ? error.message : String(error), why: "" } };
      step.value = "plan";
      plan.value = { ...plan.value, planId: undefined };
    }
    return;
  }
  if (document.error) {
    failure.value = document;
    step.value = "plan";
    plan.value = { ...plan.value, planId: undefined };
    return;
  }
  result.value = document;
  if (document.restart) {
    await restart();
    return;
  }
  events?.abort();
  step.value = "done";
  status.value = await client.value.status();
}

async function copyCommand(): Promise<void> {
  await navigator.clipboard?.writeText(command.value).catch(() => {});
}

onMounted(() => {
  rememberConsoleSection("setup");
  void load();
});
onBeforeUnmount(() => events?.abort());
</script>

<template>
  <ConsoleSearch
    :agents-base="agentsBase"
    :definitions-base="definitionsBase"
    :kv-base="kvBase"
    :search-base="searchBase"
    :sections-base="sectionsBase"
  />

  <UDashboardPanel id="setup" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
    <ConsolePageHeader title="Setup" description="development only" :toggle="false">
      <template #right>
        <UTooltip text="Read the project again">
          <UButton aria-label="Read the project again" icon="i-lucide-refresh-cw" size="sm" variant="ghost" :loading="loading" :disabled="step === 'apply' || step === 'restart'" @click="load" />
        </UTooltip>
      </template>
    </ConsolePageHeader>

    <ConsoleState v-if="loadError" :error="loadError" title="Could not open Setup" :retry="load" />
    <div v-else class="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav class="flex max-h-[45vh] min-h-0 shrink-0 flex-col overflow-y-auto border-b border-default md:max-h-none md:w-80 md:border-r md:border-b-0" aria-label="Features">
        <dl class="vitehub-setup__project grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-b border-default px-4 py-3 text-xs">
          <dt class="text-muted">Framework</dt>
          <dd class="min-w-0 truncate text-highlighted">
            <USkeleton v-if="loading && !status" class="h-3.5 w-16" />
            <template v-else>{{ frameworkLabel }} <span class="text-dimmed">detected</span></template>
          </dd>
          <dt class="text-muted">Host</dt>
          <dd class="min-w-0 truncate text-highlighted">
            <USkeleton v-if="loading && !status" class="h-3.5 w-20" />
            <template v-else>{{ hostName }} <span class="text-dimmed">{{ hostSource }}</span></template>
          </dd>
          <dt class="text-muted">Config</dt>
          <dd class="min-w-0 truncate font-mono text-highlighted">
            <USkeleton v-if="loading && !status" class="h-3.5 w-24" />
            <template v-else>{{ status?.config.file ?? "none" }}</template>
          </dd>
        </dl>
        <template v-if="loading && !catalog.length">
          <USkeleton v-for="index in 10" :key="index" class="mx-2 my-1 h-8 rounded-md" />
        </template>
        <section v-for="group in groups" :key="group.id" class="px-2 py-2" :aria-labelledby="`setup-group-${group.id}`">
          <h2 :id="`setup-group-${group.id}`" class="px-2 pb-1 text-[11px] font-medium text-muted">{{ group.label }}</h2>
          <button
            v-for="feature in group.features"
            :key="feature.id"
            type="button"
            class="vitehub-console__section-link w-full shrink-0 text-start"
            :aria-current="feature.id === selectedId ? 'true' : undefined"
            @click="select(feature.id)"
          >
            <span class="min-w-0 flex-1 truncate text-sm" :class="group.id === 'unsupported' ? 'text-muted' : undefined">{{ feature.title }}</span>
            <UBadge :label="stateLabel(feature).label" :color="stateLabel(feature).tone" size="sm" variant="subtle" />
          </button>
        </section>
      </nav>

      <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Change">
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div v-if="!selected" class="p-6">
            <UEmpty v-if="!loading" variant="naked" icon="i-lucide-blocks" title="Choose a feature" description="Pick a feature on the left to turn it on or off." />
          </div>

          <div v-else class="grid max-w-3xl gap-5 p-6">
            <header class="grid gap-1.5">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-base font-semibold text-highlighted">{{ selected.title }}</h2>
                <UBadge :label="stateLabel(selected).label" :color="stateLabel(selected).tone" size="sm" variant="subtle" />
              </div>
              <p class="text-sm text-muted">{{ selected.summary }}</p>
              <p v-if="readOnly" class="text-xs text-muted">This access can only read Setup. You can preview changes but cannot apply them.</p>
              <p v-if="selectedSupport" class="text-xs text-muted">
                <span class="font-medium text-toned">{{ selectedSupport.level === "native" ? `On ${hostName}: ${selectedSupport.display ?? "supported"}.` : selectedSupport.level === "explicit" ? `On ${hostName}: choose a provider.` : selectedSupport.level === "unsupported" ? `Not available on ${hostName}.` : "The host is not known." }}</span>
                {{ selectedSupport.detail }}
              </p>
              <ULink :to="`https://vitehub.dev${selected.docs}`" target="_blank" class="w-fit text-xs">Read the {{ selected.title }} docs</ULink>
            </header>

            <!-- Pick: required options, then the plan. -->
            <template v-if="step === 'pick'">
              <form v-if="selectedSupport?.level !== 'unsupported' || action === 'remove'" class="grid gap-4" @submit.prevent="makePlan">
                <div v-for="item in fields" :key="item.field" class="grid gap-1.5">
                  <label :for="`setup-option-${item.field}`" class="font-mono text-xs text-highlighted">{{ item.field }}</label>
                  <USelect
                    v-if="item.choices?.length"
                    :id="`setup-option-${item.field}`"
                    v-model="values[item.field]"
                    class="w-64"
                    size="sm"
                    :items="item.choices.map(choice => typeof choice === 'string' ? choice : { label: choice.name ?? choice.id, value: choice.id })"
                    placeholder="Choose a value"
                  />
                  <UInput v-else :id="`setup-option-${item.field}`" v-model="values[item.field]" class="w-64" size="sm" placeholder="Value" />
                </div>
                <UAlert
                  v-if="failure?.error"
                  :color="failure.missing?.length ? 'warning' : 'error'"
                  variant="subtle"
                  :title="failure.error.message"
                  :description="[failure.error.why === failure.error.message ? '' : failure.error.why, failure.error.fix].filter(Boolean).join(' ')"
                />
                <div class="flex gap-2">
                  <UButton type="submit" :label="action === 'add' ? 'Show the changes' : 'Show what goes'" :icon="action === 'add' ? 'i-lucide-plus' : 'i-lucide-minus'" :loading="planning" />
                </div>
              </form>
              <p v-else class="text-sm text-muted">{{ selected.title }} does not run on {{ hostName }}. Set another preset in vitehub() to use it.</p>
            </template>

            <!-- Plan and apply: the diff, the packages, and the Apply button. -->
            <template v-else-if="step === 'plan' || step === 'apply'">
              <div v-if="plan?.status === 'unchanged'" class="text-sm text-muted">Nothing to change. {{ selected.title }} is already {{ action === "add" ? "on" : "off" }}.</div>
              <template v-else>
                <div v-for="change in changes" :key="change.path" class="grid gap-1.5">
                  <p class="flex items-center gap-2 text-xs">
                    <span class="font-mono text-highlighted">{{ change.path }}</span>
                    <span class="text-muted">{{ change.kind === "create" ? "new file" : change.kind === "delete" ? "deleted" : "changed" }}</span>
                  </p>
                  <MultiFileDiff
                    class="overflow-hidden rounded-md border border-default text-xs tabular-nums"
                    :old-file="{ contents: change.before ?? '', name: change.path }"
                    :new-file="{ contents: change.after, name: change.path }"
                    :options="{ diffStyle: 'unified', disableFileHeader: true, overflow: 'wrap' }"
                  />
                </div>
                <p v-if="packages" class="text-xs text-muted">Packages: <code class="font-mono text-highlighted">{{ packages }}</code></p>
                <p v-if="alsoChanges" class="text-xs text-muted">{{ alsoChanges }}</p>
                <p v-if="plan?.restart" class="text-xs text-muted">The config changes, so the dev server restarts after Apply.</p>
              </template>
              <UAlert v-if="failure?.error" color="error" variant="subtle" :title="failure.error.message" :description="[failure.error.why === failure.error.message ? '' : failure.error.why, failure.error.fix].filter(Boolean).join(' ')" />
              <pre v-if="logs" class="max-h-56 overflow-auto rounded-md border border-default bg-elevated/50 p-3 font-mono text-xs leading-5 text-toned" aria-label="Install output" aria-live="polite">{{ logs }}</pre>
              <div class="flex gap-2">
                <UButton v-if="plan?.planId && !readOnly" label="Apply" icon="i-lucide-check" :loading="step === 'apply'" @click="apply" />
                <UButton v-else-if="failure?.error" label="Plan again" icon="i-lucide-refresh-cw" @click="makePlan" />
                <UButton label="Back" variant="ghost" :disabled="step === 'apply'" @click="select(selected.id)" />
              </div>
            </template>

            <template v-else-if="step === 'restart'">
              <p v-if="!restartFailed" role="status" class="flex items-center gap-2 text-sm text-muted">
                <UIcon name="i-lucide-loader-circle" class="size-4 motion-safe:animate-spin" aria-hidden="true" />
                Restarting the dev server. The page reloads when it is back.
              </p>
              <UAlert v-else color="warning" variant="subtle" title="The dev server did not come back" description="The change is written. Restart the dev server by hand, then reload this page." />
              <pre v-if="logs" class="max-h-56 overflow-auto rounded-md border border-default bg-elevated/50 p-3 font-mono text-xs leading-5 text-toned" aria-label="Install output">{{ logs }}</pre>
            </template>

            <template v-else-if="step === 'done'">
              <UAlert color="success" variant="subtle" icon="i-lucide-check" :title="selectedState?.enabled === 'on' ? `${selected.title} is on` : `${selected.title} is off`" :description="result?.changes?.length ? `Changed ${result.changes.map(change => change.path).join(', ')}.${result.restart ? ' The dev server restarted.' : ' No restart needed.'}` : 'No files changed.'" />
              <ul v-if="result?.nextSteps?.length" class="grid list-disc gap-1 ps-5 text-xs text-muted">
                <li v-for="next in result.nextSteps" :key="next">{{ next }}</li>
              </ul>
            </template>
          </div>
        </div>

        <footer class="flex min-h-11 items-center gap-2 border-t border-default px-4 py-2">
          <span class="shrink-0 text-xs text-muted">CLI</span>
          <code class="min-w-0 flex-1 truncate font-mono text-xs text-highlighted" :title="command">{{ command }}</code>
          <UTooltip text="Copy the command">
            <UButton aria-label="Copy the command" icon="i-lucide-copy" size="xs" variant="ghost" @click="copyCommand" />
          </UTooltip>
        </footer>
      </section>
    </div>
  </UDashboardPanel>
</template>
