<script setup lang="ts">
import ConsoleSetupHint from "./console-setup-hint.vue";
const snippet = `import { createDatabaseAuthEventStore, defineAuth } from 'vite-hub/auth'
import { useDatabase } from 'vite-hub/database/drizzle'

export default defineAuth(() => {
  const { db } = useDatabase('auth')
  return {
    // Keep your existing database adapter and auth options.
    events: { store: createDatabaseAuthEventStore({ db }) },
  }
})`;
</script>

<template>
  <section class="space-y-3 p-4 text-sm" aria-label="Auth event setup">
    <h2 class="font-medium text-highlighted">Record auth events</h2>
    <p class="max-w-2xl text-muted">
      <ConsoleSetupHint
        :hint="{
          message:
            'Add `events.store` to `defineAuth()` in your Auth Definition to enable activity and sign-in analytics.',
          docs: 'https://vitehub.dev/docs/auth/console#enable-events',
        }"
      />
    </p>
    <p class="max-w-2xl text-xs text-muted">
      This example uses a SQLite Database Definition named <code>auth</code>. The event store also
      supports Cloudflare D1. It records new events after setup.
    </p>
    <pre
      class="overflow-x-auto rounded-md bg-elevated p-3 text-xs leading-relaxed text-toned"
    ><code>{{ snippet }}</code></pre>
  </section>
</template>
