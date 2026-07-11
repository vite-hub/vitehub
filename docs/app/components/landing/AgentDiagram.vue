<script setup lang="ts">
const boundaries = [
  { label: "Driver", value: "Application code", icon: "i-lucide-cpu" },
  { label: "Workspace", value: "Repository", icon: "i-lucide-folder-tree" },
  { label: "Capability", value: "Blob", icon: "i-lucide-blocks" },
  { label: "Instructions", value: "AGENTS.md", icon: "i-lucide-file-text" },
] as const;
</script>

<template>
  <figure
    class="agent-diagram overflow-hidden border border-default bg-default"
    role="img"
    aria-label="A GitHub pull request flows into an Agent Definition composed from a Driver, Workspace, Capability, and instructions, then leaves as an Agent Invocation."
  >
    <figcaption
      class="flex min-h-11 items-center justify-between gap-4 border-b border-default bg-muted/40 px-4 font-mono text-xs text-muted"
    >
      <span>server/agents/review.ts</span>
      <span class="hidden sm:inline">Agent Definition</span>
    </figcaption>

    <div class="relative px-4 py-10 sm:px-7 sm:py-12 lg:px-9 lg:py-14">
      <div
        class="agent-flow grid grid-cols-[minmax(4.5rem,1fr)_minmax(1.5rem,0.5fr)_minmax(6.5rem,0.9fr)_minmax(1.5rem,0.5fr)_minmax(4.5rem,1fr)] items-center"
      >
        <div class="agent-endpoint justify-self-start">
          <UIcon name="i-lucide-git-pull-request" class="size-4" aria-hidden="true" />
          <span>GitHub PR</span>
        </div>

        <span class="agent-rail" aria-hidden="true"><span /></span>

        <div class="agent-core">
          <svg viewBox="0 0 80 72" class="size-20 sm:size-24" aria-hidden="true">
            <polygon points="20,4 60,4 78,36 60,68 20,68 2,36" fill="currentColor" />
            <polygon
              class="agent-core-ring"
              points="23,10 57,10 71,36 57,62 23,62 9,36"
              fill="none"
              stroke="var(--ui-bg)"
              stroke-width="1.5"
            />
          </svg>
          <span class="font-mono text-[0.6875rem] font-medium text-inverted sm:text-xs">Agent</span>
        </div>

        <span class="agent-rail agent-rail-delay" aria-hidden="true"><span /></span>

        <div class="agent-endpoint justify-self-end">
          <UIcon name="i-lucide-activity" class="size-4" aria-hidden="true" />
          <span>Invocation</span>
        </div>
      </div>

      <div class="agent-trunk" aria-hidden="true">
        <span v-for="index in 4" :key="index" />
      </div>

      <div class="mt-14 grid grid-cols-2 gap-px bg-default sm:mt-16 sm:grid-cols-4">
        <div
          v-for="(boundary, index) in boundaries"
          :key="boundary.label"
          class="agent-boundary min-w-0 border border-default bg-default p-3 sm:p-4"
          :style="{ '--agent-delay': `${index * 1.1}s` }"
        >
          <div class="flex items-center gap-2 text-muted">
            <UIcon :name="boundary.icon" class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="font-mono text-[0.6875rem] uppercase tracking-[0.12em]">{{
              boundary.label
            }}</span>
          </div>
          <p class="mt-2 truncate text-sm font-medium text-highlighted">
            {{ boundary.value }}
          </p>
        </div>
      </div>
    </div>
  </figure>
</template>

<style scoped>
.agent-diagram {
  background-image:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--ui-border) 46%, transparent) 1px,
      transparent 1px
    ),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--ui-border) 38%, transparent) 1px,
      transparent 1px
    );
  background-position: center;
  background-size: 4rem 4rem;
}

.agent-endpoint {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  padding: 0.625rem 0.75rem;
  color: var(--ui-text-muted);
  font-family: var(--font-mono), ui-monospace, monospace;
  font-size: 0.75rem;
  white-space: nowrap;
}

.agent-rail {
  position: relative;
  height: 1px;
  overflow: hidden;
  background: var(--ui-border-accented);
}

.agent-rail span {
  position: absolute;
  top: -1px;
  left: 0;
  width: 30%;
  height: 3px;
  background: var(--ui-text-highlighted);
  animation: agent-flow 2.8s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}

.agent-rail-delay span {
  animation-delay: 1.4s;
}

.agent-core {
  position: relative;
  display: grid;
  place-items: center;
  justify-self: center;
  color: var(--ui-text-highlighted);
}

.agent-core > * {
  grid-area: 1 / 1;
}

.agent-core-ring {
  animation: agent-core-pulse 2.8s cubic-bezier(0.65, 0, 0.35, 1) infinite;
  transform-origin: center;
}

.agent-trunk {
  position: relative;
  width: calc(75% + 1px);
  height: 2.75rem;
  margin: 0 auto -3.5rem;
  border-top: 1px solid var(--ui-border-accented);
}

.agent-trunk::before {
  position: absolute;
  bottom: 100%;
  left: 50%;
  width: 1px;
  height: 2.25rem;
  background: var(--ui-border-accented);
  content: "";
}

.agent-trunk span {
  position: absolute;
  top: -0.25rem;
  width: 0.5rem;
  height: 0.5rem;
  border: 1px solid var(--ui-border-accented);
  border-radius: 999px;
  background: var(--ui-bg);
}

.agent-trunk span:nth-child(1) {
  left: 0;
}
.agent-trunk span:nth-child(2) {
  left: 33.333%;
}
.agent-trunk span:nth-child(3) {
  left: 66.666%;
}
.agent-trunk span:nth-child(4) {
  right: 0;
}

.agent-boundary {
  animation: agent-boundary 4.4s cubic-bezier(0.65, 0, 0.35, 1) infinite;
  animation-delay: var(--agent-delay);
}

@keyframes agent-flow {
  0% {
    opacity: 0;
    transform: translateX(-120%);
  }
  20% {
    opacity: 1;
  }
  75% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateX(440%);
  }
}

@keyframes agent-core-pulse {
  0%,
  100% {
    opacity: 0.28;
    transform: scale(0.92);
  }
  50% {
    opacity: 0.72;
    transform: scale(1);
  }
}

@keyframes agent-boundary {
  0%,
  100% {
    opacity: 0.58;
    transform: translateY(0);
  }
  18%,
  38% {
    opacity: 1;
    transform: translateY(-2px);
  }
  56% {
    opacity: 0.58;
    transform: translateY(0);
  }
}

@media (max-width: 39.999rem) {
  .agent-endpoint {
    flex-direction: column;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.5rem;
    font-size: 0.625rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-rail span,
  .agent-core-ring,
  .agent-boundary {
    animation: none;
  }

  .agent-rail span {
    display: none;
  }

  .agent-boundary,
  .agent-core-ring {
    opacity: 1;
  }
}
</style>
