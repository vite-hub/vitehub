<script setup lang="ts">
const invocations = [
  { title: "Review pull request", status: "Completed", detail: "3 tool calls · 2m ago" },
  { title: "Fix failing tests", status: "Running", detail: "1 tool call · Just now" },
  { title: "Summarize changes", status: "Queued", detail: "Waiting to start" },
];
</script>

<template>
  <div class="grid gap-4 rounded-lg border border-default bg-default p-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
    <div>
      <h3 class="mb-3 text-sm font-semibold text-highlighted">Invocations</h3>
      <ul class="space-y-1">
        <li v-for="invocation in invocations" :key="invocation.title">
          <button class="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted">
            <span class="block font-medium text-highlighted">{{ invocation.title }}</span>
            <span class="text-xs text-muted">{{ invocation.status }}</span>
          </button>
        </li>
      </ul>
    </div>
    <div class="rounded-md bg-muted/30 p-4">
      <p class="text-sm font-semibold text-highlighted">Review pull request</p>
      <p class="mt-2 text-sm text-muted">The invocation completed successfully after checking the repository.</p>
      <p class="mt-4 text-xs text-muted">3 tool calls · 2m ago</p>
    </div>
  </div>
</template>
