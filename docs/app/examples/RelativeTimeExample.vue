<script setup lang="ts">
// One moment per page load, so the server and the browser render the same deploys.
const now = useState("relative-time-example-now", () => Date.now()).value;
const minute = 60_000;
const day = 86_400_000;
const deploys = [
  { id: "dpl_8f2k", branch: "main", at: now - 4 * minute },
  { id: "dpl_7c1m", branch: "fix/pricing-copy", at: now - 3 * 60 * minute },
  { id: "dpl_6b9q", branch: "main", at: now - 2 * day },
  { id: "dpl_5a0z", branch: "feat/checkout", at: now - 20 * day },
  { id: "dpl_4x7n", branch: "main", at: now - 21 * day },
  { id: "dpl_2e5r", branch: "main", at: now - 400 * day },
];
</script>

<template>
  <ul class="flex w-full max-w-sm flex-col divide-y divide-default text-sm">
    <li v-for="deploy in deploys" :key="deploy.id" class="flex items-center justify-between gap-4 py-2">
      <span class="font-mono">{{ deploy.branch }}</span>
      <RelativeTime :at="deploy.at" format="short" class="text-muted" />
    </li>
  </ul>
</template>
