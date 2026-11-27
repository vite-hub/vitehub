<script setup lang="ts">
import { tokenize } from "./code";
import { portabilityExamples } from "./content";

const exampleItems = portabilityExamples.map((example) => ({ label: example.label, value: example.id }));
const activeId = ref<string>(portabilityExamples[0].id);
const activeExample = computed(() => portabilityExamples.find((example) => example.id === activeId.value) ?? portabilityExamples[0]);
const activeLines = computed(() => activeExample.value.code.map(tokenize));
const choices = useTemplateRef<HTMLElement>("choices");

// Seven tabs scroll sideways on small screens. Keep the chosen one in view.
watch(activeId, async () => {
  await nextTick();
  choices.value?.querySelector('[data-state="active"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
});
</script>

<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.8fr)] lg:items-end lg:gap-20">
        <h2 class="max-w-[13ch] text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12 lg:text-6xl/14">
          Write once.<br>Deploy anywhere.
        </h2>
        <p class="max-w-[36ch] text-lg/7 text-muted text-pretty">
          Same code on every host. The host picks the provider.
        </p>
      </div>

      <div class="mt-10 lg:mt-14">
        <!-- pb-px keeps the tab underline, which hangs 1px below the list, inside the scroll box. -->
        <div ref="choices" class="-mx-4 overflow-x-auto px-4 pb-px [scrollbar-width:none] sm:mx-0 sm:px-0">
          <UTabs v-model="activeId" :items="exampleItems" :content="false" class="w-max min-w-full" />
        </div>

        <div class="mt-4 grid rounded-lg border border-default lg:grid-cols-[minmax(0,1.5fr)_minmax(16rem,0.8fr)]">
          <div class="flex min-w-0 flex-col">
            <!-- The docs link and the providers end at the right edge, and a label morph keeps its letters from the left, so
                 an old letter that leaves can pass the edge. overflow-hidden keeps it inside the panel. -->
            <div class="flex min-h-11 items-center justify-between gap-3 overflow-hidden border-b border-default px-4 font-mono text-xs text-muted">
              <span class="flex min-w-0 items-center gap-2">
                <UIcon name="i-lucide-file-code-2" class="size-3.5 shrink-0" aria-hidden="true" />
                <MorphText :text="activeExample.path" class="truncate" />
              </span>
              <NuxtLink
                :to="activeExample.to"
                :aria-label="`${activeExample.label} docs`"
                class="inline-flex shrink-0 items-center gap-1 font-sans text-xs text-muted transition-colors hover:text-highlighted"
              >
                <MorphText :text="`${activeExample.label} docs`" class="max-sm:hidden" />
                <span class="sm:hidden">Docs</span>
                <UIcon name="i-lucide-arrow-right" class="size-3.5" aria-hidden="true" />
              </NuxtLink>
            </div>
            <!-- The code is read, so it crossfades. The path above it and the providers beside it morph. -->
            <Transition name="example" mode="out-in">
              <pre :key="activeExample.id" class="portability-code overflow-x-auto px-4 py-5 font-mono text-xs/6 sm:px-6 sm:text-sm/7"><code><span v-for="(line, lineIndex) in activeLines" :key="lineIndex"><span v-for="(token, tokenIndex) in line" :key="tokenIndex" :class="`token-${token.kind}`">{{ token.text }}</span>{{ "\n" }}</span></code></pre>
            </Transition>
          </div>

          <div class="flex flex-col border-t border-default lg:border-t-0 lg:border-l">
            <p class="flex min-h-11 items-center border-b border-default px-4 font-mono text-xs text-muted">Provider per host</p>
            <!-- A host that stays keeps its row and morphs its provider. A host that leaves folds, and a new one grows. -->
            <MotionList tag="ul" class="provider-list flex-1 overflow-hidden" aria-label="Provider for each host">
              <li v-for="host in activeExample.hosts" :key="host.name" class="flex min-h-12 items-center justify-between gap-4 border-b border-default px-4">
                <span class="inline-flex items-center gap-2 text-sm text-highlighted">
                  <UIcon :name="host.icon" class="size-4 shrink-0 text-muted" aria-hidden="true" />
                  {{ host.name }}
                </span>
                <MorphText :text="host.provider" class="text-right text-xs text-muted" />
              </li>
            </MotionList>
            <NuxtLink
              to="/docs/frameworks-hosts/support-matrix"
              class="inline-flex min-h-11 items-center gap-1.5 px-4 text-xs text-muted transition-colors hover:text-highlighted"
            >
              Full support matrix
              <UIcon name="i-lucide-arrow-up-right" class="size-3.5" aria-hidden="true" />
            </NuxtLink>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.portability-code {
  min-height: 17.5rem;
  color: var(--ui-text-muted);
}

.token-keyword,
.token-call {
  color: var(--ui-text-highlighted);
}

.token-keyword {
  font-weight: 500;
}

.token-string {
  color: var(--ui-text-toned);
}

/* The code crossfades in 150ms, as a label does under reduced motion. */
.example-enter-active,
.example-leave-active {
  transition: opacity 75ms ease;
}

.example-enter-from,
.example-leave-to {
  opacity: 0;
}
</style>
