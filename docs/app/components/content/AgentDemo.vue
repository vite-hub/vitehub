<script setup lang="ts">
// `::agent-demo` in Markdown mounts the interactive Agent playground from the site landing page.
import { MotionConfig } from "motion-v";
import AgentPlayground from "../landing/AgentPlayground.vue";
</script>

<template>
  <div class="not-prose vh-agent-demo">
    <div class="vh-agent-demo-stage">
      <ClientOnly>
        <MotionConfig reduced-motion="user">
          <AgentPlayground class="min-w-0" />
        </MotionConfig>
        <template #fallback>
          <div
            role="status"
            class="grid h-full place-items-center rounded-lg border border-default text-sm text-muted"
          >
            Loading Agent playground...
          </div>
        </template>
      </ClientOnly>
    </div>
  </div>
</template>

<style scoped>
.vh-agent-demo {
  margin: 2rem 0;
  container-type: inline-size;
}

.vh-agent-demo-stage {
  --agent-playground-height: 48rem;
  height: var(--agent-playground-height);
}

@container (min-width: 40rem) {
  .vh-agent-demo-stage {
    --agent-playground-height: 38rem;
  }
}
</style>
