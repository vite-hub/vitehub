<script setup lang="ts">
const files = [
  { label: "instructions.md", icon: "i-lucide-file-text", kind: "Markdown" },
  { label: "skills/", icon: "i-lucide-folder", kind: "Markdown" },
  { label: "tools.ts", icon: "i-lucide-file-code-2", kind: "TypeScript" },
] as const;
</script>

<template>
  <figure
    class="agent-diagram overflow-hidden border border-default bg-default"
    role="img"
    aria-label="An Agent Definition combines Markdown instructions and skills with TypeScript tools, then handles an invocation."
  >
    <figcaption
      class="flex min-h-11 items-center justify-between gap-4 border-b border-default bg-muted/40 px-4 font-mono text-xs text-muted"
    >
      <span>server/agents/review/</span>
      <span class="hidden sm:inline">Agent Definition</span>
    </figcaption>

    <div class="relative p-4 sm:p-7 lg:p-9">
      <div class="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_3.5rem_minmax(8rem,.72fr)]">
        <div class="agent-files border border-default bg-default p-3 sm:p-4">
          <div
            class="flex items-center gap-2 border-b border-default pb-3 font-mono text-xs font-medium text-highlighted"
          >
            <UIcon name="i-lucide-folder-open" class="size-4" aria-hidden="true" />
            review/
          </div>
          <ul class="mt-2" role="list">
            <li
              v-for="(file, index) in files"
              :key="file.label"
              class="agent-file flex items-center gap-2.5 py-2"
              :style="{ '--file-delay': `${index * 900}ms` }"
            >
              <UIcon :name="file.icon" class="size-4 shrink-0 text-muted" aria-hidden="true" />
              <span class="font-mono text-xs text-highlighted sm:text-sm">{{ file.label }}</span>
              <span
                class="ml-auto hidden text-[0.625rem] uppercase tracking-[0.12em] text-dimmed sm:block"
                >{{ file.kind }}</span
              >
            </li>
          </ul>
        </div>

        <div class="agent-connector hidden sm:block" aria-hidden="true"><span /></div>

        <div
          class="agent-invocation flex min-h-28 flex-col justify-between border border-default bg-default p-4"
        >
          <div class="flex items-center gap-2 text-muted">
            <UIcon name="i-lucide-message-square-code" class="size-4" aria-hidden="true" />
            <span class="font-mono text-[0.6875rem] uppercase tracking-[0.12em]">Invocation</span>
          </div>
          <div>
            <p class="text-sm font-medium text-highlighted">Review this pull request</p>
            <p class="mt-1 font-mono text-xs text-muted">→ review.ts</p>
          </div>
        </div>
      </div>

      <div
        class="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-default pt-4 font-mono text-[0.6875rem] text-muted sm:mt-8"
      >
        <span class="uppercase tracking-[0.12em] text-dimmed">Choose a driver</span>
        <span>Model</span>
        <span>Harness</span>
        <span>Custom</span>
      </div>
    </div>
  </figure>
</template>

<style scoped>
.agent-diagram {
  background-image:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--ui-border) 42%, transparent) 1px,
      transparent 1px
    ),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--ui-border) 34%, transparent) 1px,
      transparent 1px
    );
  background-position: center;
  background-size: 4rem 4rem;
}

.agent-file::before {
  width: 0.25rem;
  height: 0.25rem;
  border-radius: 999px;
  background: var(--ui-text-highlighted);
  content: "";
  opacity: 0.18;
  animation: agent-file-read 4.8s cubic-bezier(0.22, 1, 0.36, 1) infinite;
  animation-delay: var(--file-delay);
}

.agent-connector {
  position: relative;
  height: 1px;
  overflow: hidden;
  background: var(--ui-border-accented);
}
.agent-connector span {
  position: absolute;
  inset-block: -1px;
  left: 0;
  width: 35%;
  background: var(--ui-text-highlighted);
  animation: agent-connect 3.6s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}
.agent-invocation {
  animation: agent-invoke 3.6s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}

@keyframes agent-file-read {
  0%,
  14%,
  100% {
    opacity: 0.18;
    transform: scale(0.8);
  }
  5%,
  9% {
    opacity: 0.9;
    transform: scale(1.15);
  }
}
@keyframes agent-connect {
  0% {
    opacity: 0;
    transform: translateX(-110%);
  }
  22%,
  72% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateX(390%);
  }
}
@keyframes agent-invoke {
  0%,
  42%,
  100% {
    background: var(--ui-bg);
  }
  55%,
  74% {
    background: color-mix(in srgb, var(--ui-text-highlighted) 5%, var(--ui-bg));
  }
}
@media (prefers-reduced-motion: reduce) {
  .agent-file::before,
  .agent-connector span,
  .agent-invocation {
    animation: none;
  }
  .agent-connector span {
    display: none;
  }
}
</style>
