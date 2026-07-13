<script setup lang="ts">
const parts = [
  { label: "Instructions", value: "instructions.md", icon: "i-lucide-file-text" },
  { label: "Skill", value: "review", icon: "i-lucide-folder" },
  { label: "Workspace", value: "PR checkout", icon: "i-lucide-folder-git-2" },
  { label: "Capability", value: "workspaceShell()", icon: "i-lucide-square-terminal" },
] as const;
</script>

<template>
  <figure
    class="agent-diagram overflow-hidden border border-default bg-default p-5 sm:p-7 lg:p-9"
    role="img"
    aria-label="Pull request 574 enters a Review Agent composed of instructions, a review Skill, a pull request Workspace, and a workspace shell Capability. The Agent returns three findings."
  >
    <div class="agent-flow">
      <div class="agent-endpoint agent-input">
        <UIcon name="i-lucide-git-pull-request" class="size-5 text-muted" aria-hidden="true" />
        <div>
          <p class="font-mono text-sm font-medium text-highlighted">PR #574</p>
          <p class="mt-0.5 text-xs text-muted">GitHub</p>
        </div>
      </div>

      <div class="agent-rail agent-rail-in" aria-hidden="true"><span /></div>

      <div class="agent-definition">
        <div class="flex items-center gap-2.5 border-b border-default px-4 py-3.5">
          <UIcon name="i-lucide-bot" class="size-4 text-muted" aria-hidden="true" />
          <span class="font-mono text-sm font-medium text-highlighted">Review Agent</span>
        </div>

        <ul class="p-2" role="list">
          <li
            v-for="(part, index) in parts"
            :key="part.label"
            class="agent-part grid grid-cols-1 items-center gap-1 px-2 py-2.5 sm:grid-cols-[1fr_auto] sm:gap-3"
            :style="{ '--part-index': index }"
          >
            <span class="flex min-w-0 items-center gap-2 text-xs text-muted">
              <UIcon :name="part.icon" class="size-3.5 shrink-0" aria-hidden="true" />
              {{ part.label }}
            </span>
            <span class="pl-[1.375rem] font-mono text-xs text-highlighted sm:pl-0">{{
              part.value
            }}</span>
          </li>
        </ul>
      </div>

      <div class="agent-rail agent-rail-out" aria-hidden="true"><span /></div>

      <div class="agent-endpoint agent-output">
        <UIcon name="i-lucide-circle-check" class="size-5 text-muted" aria-hidden="true" />
        <div>
          <p class="font-mono text-sm font-medium text-highlighted">3 findings</p>
          <p class="mt-0.5 text-xs text-muted">Review posted</p>
        </div>
      </div>
    </div>
  </figure>
</template>

<style scoped>
.agent-flow {
  display: grid;
  align-items: center;
}

.agent-endpoint {
  display: flex;
  min-height: 5rem;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  padding: 1rem;
}

.agent-definition {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.agent-part {
  position: relative;
  isolation: isolate;
}

.agent-part::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  background: color-mix(in srgb, var(--ui-text-highlighted) 6%, transparent);
  content: "";
  opacity: 0;
  animation: agent-read 7.6s cubic-bezier(0.22, 1, 0.36, 1) infinite;
  animation-delay: calc(var(--part-index) * 320ms);
}

.agent-rail {
  --flow-from: translateY(-130%);
  --flow-to: translateY(390%);

  position: relative;
  width: 1px;
  height: 2rem;
  justify-self: center;
  overflow: hidden;
  background: var(--ui-border-accented);
}

.agent-rail span {
  position: absolute;
  top: 0;
  left: -1px;
  width: 3px;
  height: 35%;
  background: var(--ui-text-highlighted);
}

.agent-rail-in span {
  animation: agent-flow-in 7.6s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}

.agent-rail-out span {
  animation: agent-flow-out 7.6s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}

.agent-output {
  animation: agent-output 7.6s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}

@media (min-width: 40rem) {
  .agent-flow {
    grid-template-columns:
      minmax(7rem, 0.72fr) minmax(1.5rem, 0.22fr) minmax(14rem, 1.5fr)
      minmax(1.5rem, 0.22fr) minmax(7rem, 0.72fr);
  }

  .agent-rail {
    --flow-from: translateX(-130%);
    --flow-to: translateX(390%);

    width: auto;
    height: 1px;
    justify-self: stretch;
  }

  .agent-rail span {
    top: -1px;
    left: 0;
    width: 35%;
    height: 3px;
  }
}

@keyframes agent-read {
  0%,
  20%,
  32%,
  100% {
    opacity: 0;
  }
  24%,
  29% {
    opacity: 1;
  }
}

@keyframes agent-output {
  0%,
  61%,
  100% {
    background: var(--ui-bg);
  }
  69%,
  88% {
    background: color-mix(in srgb, var(--ui-text-highlighted) 6%, var(--ui-bg));
  }
}

@keyframes agent-flow-in {
  0%,
  8% {
    opacity: 0;
    transform: var(--flow-from);
  }
  12%,
  20% {
    opacity: 1;
  }
  24%,
  100% {
    opacity: 0;
    transform: var(--flow-to);
  }
}

@keyframes agent-flow-out {
  0%,
  56% {
    opacity: 0;
    transform: var(--flow-from);
  }
  61%,
  69% {
    opacity: 1;
  }
  74%,
  100% {
    opacity: 0;
    transform: var(--flow-to);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-part::before,
  .agent-rail span,
  .agent-output {
    animation: none;
  }

  .agent-rail span {
    display: none;
  }
}
</style>
