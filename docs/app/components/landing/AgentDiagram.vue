<script setup lang="ts">
const stages = [
  {
    label: "Agent Driver",
    icon: "i-lucide-cpu",
    items: ["driver.model", "driver.provider", "driver.run"],
  },
  {
    label: "Agent Definition",
    icon: "i-lucide-blocks",
    items: ["instructions.md", "workspace.sources", "capabilities[]"],
  },
  {
    label: "Agent Invocation",
    icon: "i-lucide-cloud",
    items: ["runAgent()", "invoker", "runtime"],
  },
] as const;
</script>

<template>
  <figure
    class="overflow-hidden border border-default bg-default p-5 sm:p-7 lg:p-9"
    role="img"
    aria-label="A ViteHub Agent Definition is configured from an Agent Driver, instructions, Workspace Sources, Capabilities, and explicit Agent Invocation context."
  >
    <div class="power-flow">
      <template v-for="(stage, index) in stages" :key="stage.label">
        <div class="power-stage" :style="{ '--stage-index': index }">
          <div class="flex items-center gap-2.5 border-b border-default px-4 py-3.5">
            <UIcon :name="stage.icon" class="size-4 text-muted" aria-hidden="true" />
            <span class="text-sm font-medium text-highlighted">{{ stage.label }}</span>
          </div>
          <ul class="space-y-1 p-2" role="list">
            <li
              v-for="item in stage.items"
              :key="item"
              class="px-2 py-2 font-mono text-xs text-muted"
            >
              {{ item }}
            </li>
          </ul>
        </div>

        <div
          v-if="index < stages.length - 1"
          class="power-rail"
          :style="{ '--rail-index': index }"
          aria-hidden="true"
        >
          <span />
        </div>
      </template>
    </div>
  </figure>
</template>

<style scoped>
.power-flow {
  display: grid;
  align-items: stretch;
}

.power-stage {
  position: relative;
  isolation: isolate;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.power-stage::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  background: color-mix(in srgb, var(--ui-text-highlighted) 5%, transparent);
  content: "";
  opacity: 0;
  animation: power-stage 7.2s cubic-bezier(0.22, 1, 0.36, 1) infinite;
  animation-delay: calc(var(--stage-index) * 900ms);
}

.power-rail {
  --flow-from: translateY(-130%);
  --flow-to: translateY(390%);

  position: relative;
  width: 1px;
  height: 2rem;
  justify-self: center;
  overflow: hidden;
  background: var(--ui-border-accented);
}

.power-rail span {
  position: absolute;
  top: 0;
  left: -1px;
  width: 3px;
  height: 35%;
  background: var(--ui-text-highlighted);
  animation: power-flow 7.2s cubic-bezier(0.22, 1, 0.36, 1) infinite;
  animation-delay: calc(450ms + var(--rail-index) * 900ms);
}

@media (min-width: 40rem) {
  .power-flow {
    grid-template-columns:
      minmax(9rem, 1fr) minmax(1.5rem, 0.18fr) minmax(11rem, 1.16fr)
      minmax(1.5rem, 0.18fr) minmax(9rem, 1fr);
  }

  .power-rail {
    --flow-from: translateX(-130%);
    --flow-to: translateX(390%);

    width: auto;
    height: 1px;
    align-self: center;
    justify-self: stretch;
  }

  .power-rail span {
    top: -1px;
    left: 0;
    width: 35%;
    height: 3px;
  }
}

@keyframes power-stage {
  0%,
  16%,
  100% {
    opacity: 0;
  }
  5%,
  11% {
    opacity: 1;
  }
}

@keyframes power-flow {
  0%,
  4% {
    opacity: 0;
    transform: var(--flow-from);
  }
  8%,
  14% {
    opacity: 1;
  }
  18%,
  100% {
    opacity: 0;
    transform: var(--flow-to);
  }
}

@media (prefers-reduced-motion: reduce) {
  .power-stage::before,
  .power-rail span {
    animation: none;
  }

  .power-rail span {
    display: none;
  }
}
</style>
