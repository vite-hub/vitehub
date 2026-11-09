<script setup lang="ts">
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@vite-hub/ui/headless";

const output = [
  "$ pnpm build",
  "> vite build",
  "vite v8.1.0 building for production...",
  "transforming (1) index.html",
  "transforming (48) src/components/Chat.vue",
  "transforming (112) src/composables/useSession.ts",
  "transforming (231) node_modules/@vite-hub/ui/dist/index.js",
  "✓ 412 modules transformed.",
  "rendering chunks (1)...",
  "rendering chunks (6)...",
  "computing gzip size (0)...",
  "computing gzip size (4)...",
  "dist/index.html                   0.46 kB │ gzip:  0.30 kB",
  "dist/assets/index-BlU3fRgV.css   18.92 kB │ gzip:  4.11 kB",
  "dist/assets/vendor-C1w9yzaN.js  142.37 kB │ gzip: 46.02 kB",
  "dist/assets/index-DkS8fA2q.js    61.08 kB │ gzip: 19.75 kB",
  "✓ built in 2.84s",
  "$ pnpm test",
  "✓ test/session.test.ts (12 tests) 41ms",
  "✓ test/chat.test.ts (34 tests) 118ms",
  "✓ test/tools.test.ts (82 tests) 302ms",
  "Test Files  3 passed (3)",
  "Tests  128 passed (128)",
  "Duration  1.92s",
];

const lines = ref<{ id: string; text: string }[]>([]);
const running = ref(false);
let interval: ReturnType<typeof setInterval> | undefined;

// Add one line every 400 ms. Scroll up to stop following. The button returns to the live edge.
function run() {
  lines.value = [];
  running.value = true;
  interval = setInterval(() => {
    const index = lines.value.length;
    const text = output[index];
    if (text === undefined) {
      clearInterval(interval);
      running.value = false;
      return;
    }
    lines.value = [...lines.value, { id: `line-${index}`, text }];
  }, 400);
}

onBeforeUnmount(() => clearInterval(interval));
</script>

<template>
  <div class="flex w-full max-w-lg flex-col gap-4">
    <MessageScroller class="h-64 rounded-md border border-default">
      <MessageScrollerViewport aria-label="Build output">
        <MessageScrollerContent
          :items="lines.map((line) => line.id)"
          :aria-busy="running ? 'true' : undefined"
          class="gap-1 p-3 font-mono text-xs"
        >
          <MessageScrollerItem v-for="line in lines" :key="line.id" :message-id="line.id" class="whitespace-pre">
            {{ line.text }}
          </MessageScrollerItem>
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton aria-label="Follow output">
        <UIcon name="i-ph-arrow-down-light" />
      </MessageScrollerButton>
    </MessageScroller>
    <UButton
      :label="running ? 'Running' : 'Run pnpm build'"
      :disabled="running"
      icon="i-ph-play-light"
      color="neutral"
      variant="outline"
      class="self-start"
      @click="run"
    />
  </div>
</template>
