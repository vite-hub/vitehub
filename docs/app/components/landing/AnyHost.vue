<script setup lang="ts">
import { useHighlightedCode } from "../../composables/useHighlightedCode";

const hosts = [
  { label: "Cloudflare", icon: "i-simple-icons-cloudflare" },
  { label: "Vercel", icon: "i-simple-icons-vercel" },
  { label: "Netlify", icon: "i-simple-icons-netlify" },
  { label: "Deno", icon: "i-simple-icons-deno" },
  { label: "Node", icon: "i-simple-icons-nodedotjs" },
  { label: "Docker", icon: "i-simple-icons-docker" },
  { label: "Fly.io", icon: "i-simple-icons-flydotio" },
] as const;

const snippets = [
  {
    label: "Authentication",
    poweredBy: "Better Auth",
    path: "server/api/me.get.ts",
    code: `import { auth } from '@vite-hub/auth'

export default defineEventHandler(async (event) => {
  const session = await auth.getSession(event)
  return session?.user ?? null
})`,
  },
  {
    label: "Database",
    poweredBy: "Drizzle",
    path: "server/api/users.get.ts",
    code: `import { db } from '@vite-hub/database'
import { users } from '../databases/main'

export default defineEventHandler(async () => {
  return db.select().from(users)
})`,
  },
  {
    label: "Scheduled jobs",
    poweredBy: "",
    path: "server/schedules/digest.ts",
    code: `import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({ cron: '0 9 * * *' }, async () => {
  await sendDailyDigest()
})`,
  },
] as const;

const { data: snippetA } = useHighlightedCode(snippets[0].path, snippets[0].code);
const { data: snippetB } = useHighlightedCode(snippets[1].path, snippets[1].code);
const { data: snippetC } = useHighlightedCode(snippets[2].path, snippets[2].code);
const highlightedSnippets = [snippetA, snippetB, snippetC];
</script>

<template>
  <section class="border-t border-default bg-default">
    <div class="mx-auto max-w-7xl px-4 py-16 sm:px-8 lg:px-12 lg:py-20">
      <h2 class="max-w-[28ch] text-4xl font-semibold tracking-tight text-highlighted text-balance">
        Write it once. Deploy anywhere.
      </h2>
      <p class="mt-5 max-w-[52ch] text-lg text-muted text-pretty">
        Add auth, a database, or a cron job in a few lines, then deploy the exact same code to Cloudflare, Vercel, or your own server. No provider SDKs to learn, no rewrites when you move hosts.
      </p>

      <ul class="mt-8 flex flex-wrap gap-2" role="list">
        <li
          v-for="host in hosts"
          :key="host.label"
          class="inline-flex items-center gap-2 rounded-sm border border-default bg-muted/40 px-3 py-1.5 text-sm font-medium text-default"
        >
          <UIcon :name="host.icon" class="size-4 shrink-0 text-muted" aria-hidden="true" />
          {{ host.label }}
        </li>
      </ul>

      <div class="mt-10 grid gap-4 lg:grid-cols-3">
        <article v-for="(snippet, index) in snippets" :key="snippet.path" class="flex flex-col">
          <div class="flex items-baseline justify-between gap-2">
            <h3 class="text-base font-medium text-highlighted">{{ snippet.label }}</h3>
            <span v-if="snippet.poweredBy" class="shrink-0 font-mono text-xs text-dimmed">Powered by {{ snippet.poweredBy }}</span>
          </div>
          <div class="vh-landing-code-card mt-3 flex-1">
            <div class="vh-landing-code-header">
              <UIcon name="i-vscode-icons-file-type-typescript-official" class="size-4 shrink-0" aria-hidden="true" />
              <span class="font-mono">{{ snippet.path }}</span>
            </div>
            <div class="code-block-wrapper overflow-x-auto text-sm" v-html="highlightedSnippets[index]?.value" />
          </div>
        </article>
      </div>
    </div>
  </section>
</template>
