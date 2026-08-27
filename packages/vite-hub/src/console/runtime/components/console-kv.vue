<script setup lang="ts">
import { ref } from "vue";

import ConsoleBackButton from "./console-back-button.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMark from "./console-mark.vue";

const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="kv-stores"
      v-model:open="sidebarOpen"
      v-model:collapsed="sidebarCollapsed"
      :default-size="19"
      :collapsed-size="4"
      :min-size="16"
      :max-size="24"
      :menu="{ title: 'KV', description: 'Inspect configured KV stores.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'border-t border-default px-3 py-2' }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <div class="flex h-10 w-full min-w-0 items-center gap-2.5 px-1.5">
          <ConsoleMark />
          <span v-if="!collapsed" class="grid min-w-0 flex-1 leading-none">
            <small class="truncate text-[10px] font-bold uppercase tracking-[.12em] text-muted">
              ViteHub Console
            </small>
            <strong class="mt-1 truncate text-sm font-semibold text-highlighted">KV</strong>
          </span>
        </div>
      </template>

      <template #default="{ collapsed }">
        <div class="px-2 pt-2">
          <ConsoleBackButton :collapsed="collapsed" />
        </div>
        <div v-if="!collapsed" class="px-4 pb-3 pt-5">
          <span class="text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
            KV storage
          </span>
          <h1 class="mt-1 text-lg font-semibold tracking-tight text-highlighted">Stores</h1>
          <p class="mt-3 text-sm leading-6 text-muted">
            Configured stores will appear here when KV inspection is implemented.
          </p>
        </div>
      </template>

      <template #footer="{ collapsed, collapse }">
        <span v-if="!collapsed" class="flex items-center gap-1.5 text-xs text-muted">
          <UIcon name="i-lucide-lock-keyhole" class="size-3.5" />Read-only
        </span>
        <UButton
          class="ml-auto max-lg:hidden"
          :icon="collapsed ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="collapsed ? 'Show KV stores' : 'Hide KV stores'"
          @click="collapse(!collapsed)"
        />
      </template>
    </UDashboardSidebar>

    <UDashboardPanel id="kv">
      <div class="flex min-h-0 flex-1 flex-col">
        <header class="flex h-14 shrink-0 items-center border-b border-default px-4">
          <UButton
            class="lg:hidden"
            aria-label="Open KV navigation"
            color="neutral"
            icon="i-lucide-panel-left"
            variant="ghost"
            @click="sidebarOpen = true"
          />
          <div class="ml-2 flex min-w-0 items-center gap-2 lg:ml-0">
            <h1 class="truncate text-sm font-semibold text-highlighted">KV</h1>
            <UBadge color="neutral" label="Planned" size="sm" variant="soft" />
          </div>
        </header>
        <UEmpty
          class="min-h-0 flex-1"
          icon="i-lucide-key-round"
          title="KV inspection is coming next"
          description="This page will provide read-only browsing for configured KV stores, keys, and values."
        />
      </div>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
