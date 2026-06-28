<script setup lang="ts">
const primitives = [
  { id: "kv", name: "KV", desc: "Small state & cache", label: "unstorage · Cloudflare KV · Upstash · Deno KV", to: "/docs/server-primitives/kv" },
  { id: "database", name: "Database", desc: "Relational data", label: "Drizzle · SQLite · libSQL · D1", to: "/docs/server-primitives/database" },
  { id: "blob", name: "Blob", desc: "Files & uploads", label: "files-sdk · R2 · Vercel Blob · S3", to: "/docs/server-primitives/blob" },
  { id: "queue", name: "Queue", desc: "Background jobs", label: "Cloudflare · Vercel", to: "/docs/server-primitives/queue" },
  { id: "workflow", name: "Workflow", desc: "Durable orchestration", label: "OpenWorkflow · Cloudflare · Vercel", to: "/docs/server-primitives/workflows" },
  { id: "schedule", name: "Schedule", desc: "Cron & recurring work", label: "Cloudflare · Vercel · Deno cron", to: "/docs/server-primitives/schedule" },
  { id: "sandbox", name: "Sandbox", desc: "Isolated execution", label: "Cloudflare · Vercel", to: "/docs/server-primitives/sandbox" },
  { id: "auth", name: "Auth", desc: "Users & sessions", label: "Better Auth", to: "/docs/server-primitives/auth" },
  { id: "env", name: "Env", desc: "Typed environment", label: "Type-safe · schema-agnostic", to: "/docs/server-primitives/env" },
  { id: "workspace", name: "Workspace", desc: "Persistent file trees", label: "Local · GitHub · R2 · Vercel Blob", to: "/docs/server-primitives/workspace" },
  { id: "source", name: "Source", desc: "Read-only content", label: "File · Glob · Markdown · GitHub · MCP", to: "/docs/server-primitives/source" },
  { id: "shell", name: "Shell", desc: "Command execution", label: "just-bash · Cloudflare", to: "/docs/server-primitives/shell" },
] as const;
</script>

<template>
  <section class="border-t border-default bg-default">
    <div class="mx-auto max-w-7xl px-4 py-16 sm:px-8 lg:px-12 lg:py-20">
      <h2 class="max-w-[30ch] text-4xl font-semibold tracking-tight text-highlighted text-balance">
        Use them with agents, or on their own.
      </h2>
      <p class="mt-5 max-w-[56ch] text-lg text-muted text-pretty">
        Auth, storage, queues, schedules, and sandboxes. Portable primitives you call from any route, job, or worker. Agents reach the same ones through Capabilities, never raw access.
      </p>

      <ul class="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" role="list">
        <li v-for="p in primitives" :key="p.id">
          <NuxtLink
            :to="p.to"
            class="group flex h-full flex-col rounded-sm border border-default bg-default p-5 transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <div class="h-16 w-full text-muted transition-colors group-hover:text-primary">
              <LandingFeatureIllust :name="p.id" />
            </div>
            <h3 class="mt-4 text-base font-medium text-highlighted">{{ p.name }}</h3>
            <p class="mt-1 text-sm text-muted">{{ p.desc }}</p>
            <p class="mt-3 font-mono text-xs text-dimmed">{{ p.label }}</p>
          </NuxtLink>
        </li>
      </ul>

      <div class="mt-8">
        <NuxtLink to="/docs/server-primitives" class="inline-flex items-center gap-1 text-sm font-medium text-highlighted hover:text-primary">
          Explore the primitives
          <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
        </NuxtLink>
      </div>
    </div>
  </section>
</template>
