<script setup lang="ts">
import { useSeoMeta } from "#app/composables/head";

useSeoMeta({
  title: "Server primitives",
  ogTitle: "Server primitives · ViteHub",
  description: "Provider-aware server primitives for Vite apps, routes, jobs, workers, and Agents.",
});

const primaryLinks = [
  {
    label: "Build with KV first",
    to: "/docs/getting-started/first-server-primitive",
    icon: "i-lucide-rocket",
  },
  {
    label: "Bridge to Agents",
    to: "/docs/agents",
    icon: "i-lucide-bot",
  },
] as const;

const heroProof = [
  { value: "Stable imports", label: "App code calls ViteHub-owned Runtime Helpers." },
  { value: "Provider output", label: "Integrations emit the host wiring." },
  { value: "Capabilities", label: "Agents get named abilities, not raw infrastructure." },
] as const;

const flowSteps = [
  {
    icon: "i-lucide-file-code",
    title: "Write normal server code.",
    text: "Routes, handlers, jobs, and workers call Runtime Helpers from Stable ViteHub Import Paths.",
  },
  {
    icon: "i-lucide-cable",
    title: "Let ViteHub own the host boundary.",
    text: "Vite Integrations discover Definitions, generate Runtime Registries, and emit Provider Output.",
  },
  {
    icon: "i-lucide-bot",
    title: "Expose only the Agent ability.",
    text: "When a model or harness needs access, attach the matching Capability to the Agent Definition.",
  },
] as const;

const primitiveGroups = [
  {
    icon: "i-lucide-key-round",
    title: "Keep small state close.",
    text: "Settings, flags, cursors, rate limits, and product records without provider-specific code in your route.",
    links: [
      { label: "KV", to: "/docs/server-primitives/kv" },
      { label: "Database", to: "/docs/server-primitives/database" },
    ],
  },
  {
    icon: "i-lucide-folder-tree",
    title: "Give files a real boundary.",
    text: "Uploads, generated artifacts, source snapshots, and Workspace sessions stay inspectable.",
    links: [
      { label: "Blob", to: "/docs/server-primitives/blob" },
      { label: "Workspace", to: "/docs/server-primitives/workspace" },
    ],
  },
  {
    icon: "i-lucide-repeat-2",
    title: "Move work off the request.",
    text: "Background delivery, durable orchestration, and recurring runtime schedules become named server work.",
    links: [
      { label: "Queue", to: "/docs/server-primitives/queue" },
      { label: "Workflows", to: "/docs/server-primitives/workflows" },
      { label: "Schedule", to: "/docs/server-primitives/schedule" },
    ],
  },
  {
    icon: "i-lucide-shield-check",
    title: "Control what execution can touch.",
    text: "Environment, auth, sandbox, and shell boundaries stay explicit before any Agent uses them.",
    links: [
      { label: "Env", to: "/docs/server-primitives/env" },
      { label: "Auth", to: "/docs/server-primitives/auth" },
      { label: "Sandbox", to: "/docs/server-primitives/sandbox" },
      { label: "Shell", to: "/docs/server-primitives/shell" },
    ],
  },
] as const;

const routeCode = `import { kv } from "@vite-hub/kv"

export default defineEventHandler(async (event) => {
  await kv.set("settings", await readBody(event))
  return { ok: true }
})`;

const agentCode = `import { defineAgent } from "@vite-hub/agent"
import { kv } from "@vite-hub/agent/capabilities"

export default defineAgent({
  driver: { model },
  capabilities: [
    kv({ mode: "read" })
  ],
})`;
</script>

<template>
  <UMain class="server-primitives-page isolate bg-default text-default">
    <section class="border-b border-default">
      <div class="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-8 lg:grid-cols-[12fr_10fr] lg:px-12 lg:py-24">
        <div class="min-w-0">
          <p class="font-mono text-base/7 text-muted sm:text-sm/6">Server primitives for Vite apps and Agents</p>
          <h1 class="mt-5 max-w-[18ch] text-5xl font-semibold tracking-tight text-highlighted text-balance sm:text-6xl">
            Stop rebuilding backend glue.
          </h1>
          <p class="mt-6 max-w-[50ch] text-lg text-muted text-pretty sm:text-base/7">
            Every Vite app eventually needs storage, files, jobs, schedules, auth, and execution. ViteHub makes those primitives portable first, then lets Agents use them through explicit Capabilities.
          </p>
          <div class="mt-8 flex flex-col gap-3 sm:flex-row">
            <NuxtLink
              :to="primaryLinks[0].to"
              class="inline-flex items-center justify-center gap-2 rounded-sm bg-highlighted px-4 py-3 text-base font-medium text-inverted ring-1 ring-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:text-sm"
            >
              <UIcon :name="primaryLinks[0].icon" class="size-4 shrink-0" aria-hidden="true" />
              {{ primaryLinks[0].label }}
            </NuxtLink>
            <NuxtLink
              :to="primaryLinks[1].to"
              class="inline-flex items-center justify-center gap-2 rounded-sm border border-default px-4 py-3 text-base font-medium text-highlighted hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:text-sm"
            >
              <UIcon :name="primaryLinks[1].icon" class="size-4 shrink-0" aria-hidden="true" />
              {{ primaryLinks[1].label }}
            </NuxtLink>
          </div>
          <dl class="mt-10 grid gap-5 sm:grid-cols-3">
            <div v-for="item in heroProof" :key="item.value" class="border-t border-default pt-4">
              <dt class="text-base font-medium text-highlighted sm:text-sm">{{ item.value }}</dt>
              <dd class="mt-2 text-base/7 text-muted sm:text-sm/6">{{ item.label }}</dd>
            </div>
          </dl>
        </div>

        <div class="server-signal grid min-w-0 content-center gap-3 rounded-sm border border-default bg-muted/30 p-4">
          <div class="relative">
            <div class="grid gap-3">
              <div class="rounded-sm border border-default bg-default p-4">
                <div class="flex items-center gap-2">
                  <UIcon name="i-lucide-route" class="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <p class="font-mono text-base/7 text-muted sm:text-sm/6">server/api/settings.put.ts</p>
                </div>
                <pre class="mt-4 overflow-x-auto text-base/7 text-highlighted sm:text-sm/6"><code>{{ routeCode }}</code></pre>
              </div>
              <dl class="grid gap-2 sm:grid-cols-3">
                <div class="rounded-sm border border-default bg-default p-3">
                  <dt class="text-base/7 font-medium text-highlighted sm:text-sm/6">Runtime Helper</dt>
                  <dd class="mt-1 text-base/7 text-muted sm:text-sm/6">@vite-hub/kv</dd>
                </div>
                <div class="rounded-sm border border-default bg-default p-3">
                  <dt class="text-base/7 font-medium text-highlighted sm:text-sm/6">Provider Output</dt>
                  <dd class="mt-1 text-base/7 text-muted sm:text-sm/6">Cloudflare, Vercel, Node</dd>
                </div>
                <div class="rounded-sm border border-default bg-default p-3">
                  <dt class="text-base/7 font-medium text-highlighted sm:text-sm/6">Agent Bridge</dt>
                  <dd class="mt-1 text-base/7 text-muted sm:text-sm/6">Capability only if needed</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="border-b border-default">
      <div class="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-8 lg:grid-cols-[7fr_13fr] lg:px-12">
        <div>
          <h2 class="max-w-[24ch] text-3xl font-semibold tracking-tight text-highlighted text-balance">
            The mess is not storage. It is the handoff.
          </h2>
          <p class="mt-4 max-w-[46ch] text-lg text-muted text-pretty sm:text-base/7">
            Apps usually glue together provider SDKs, generated files, queues, cron config, and model tools by hand. ViteHub turns that glue into inspectable primitives with one public model.
          </p>
        </div>
        <dl class="grid gap-5">
          <div v-for="item in flowSteps" :key="item.title" class="grid gap-4 border-t border-default pt-5 sm:grid-cols-[auto_1fr]">
            <UIcon :name="item.icon" class="size-5 shrink-0 text-muted" aria-hidden="true" />
            <div class="min-w-0">
              <dt class="text-lg font-medium text-highlighted sm:text-base">{{ item.title }}</dt>
              <dd class="mt-2 max-w-[68ch] text-base/7 text-muted sm:text-sm/6">{{ item.text }}</dd>
            </div>
          </div>
        </dl>
      </div>
    </section>

    <section class="border-b border-default">
      <div class="mx-auto max-w-7xl px-4 py-14 sm:px-8 lg:px-12">
        <div>
          <h2 class="max-w-[30ch] text-3xl font-semibold tracking-tight text-highlighted text-balance">
            Pick the primitive by the job you are trying to finish.
          </h2>
          <p class="mt-4 max-w-[56ch] text-lg text-muted text-pretty sm:text-base/7">
            Start with app infrastructure. Move to Agents only when an Agent Invocation should receive a controlled ability.
          </p>
        </div>
        <div class="mt-8 grid gap-4 md:grid-cols-2">
          <article v-for="group in primitiveGroups" :key="group.title" class="rounded-sm border border-default p-5">
            <div class="flex items-start gap-3">
              <UIcon :name="group.icon" class="size-5 shrink-0 text-muted" aria-hidden="true" />
              <div class="min-w-0">
                <h3 class="text-lg font-medium text-highlighted sm:text-base">{{ group.title }}</h3>
                <p class="mt-2 text-base/7 text-muted text-pretty sm:text-sm/6">{{ group.text }}</p>
                <div class="mt-4 flex flex-wrap gap-2">
                  <NuxtLink
                    v-for="link in group.links"
                    :key="link.to"
                    :to="link.to"
                    class="inline-flex items-center gap-1 rounded-sm border border-default px-2.5 py-1.5 text-base font-medium text-highlighted hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:text-sm"
                  >
                    {{ link.label }}
                    <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
                  </NuxtLink>
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>

    <section class="border-b border-default">
      <div class="mx-auto grid max-w-7xl gap-6 px-4 py-14 sm:px-8 lg:grid-cols-2 lg:px-12">
        <div class="rounded-sm border border-default bg-muted/20 p-4">
          <p class="font-mono text-base/7 text-muted sm:text-sm/6">Server code gets Runtime Helpers</p>
          <pre class="mt-4 overflow-x-auto text-base/7 text-highlighted sm:text-sm/6"><code>{{ routeCode }}</code></pre>
          <NuxtLink to="/docs/concepts/runtime-helpers-and-stable-imports" class="mt-4 inline-flex items-center gap-1 text-base font-medium text-primary hover:text-primary/75 sm:text-sm">
            Stable import model
            <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
          </NuxtLink>
        </div>
        <div class="rounded-sm border border-default bg-muted/20 p-4">
          <p class="font-mono text-base/7 text-muted sm:text-sm/6">Agents get Capabilities</p>
          <pre class="mt-4 overflow-x-auto text-base/7 text-highlighted sm:text-sm/6"><code>{{ agentCode }}</code></pre>
          <NuxtLink to="/docs/capabilities" class="mt-4 inline-flex items-center gap-1 text-base font-medium text-primary hover:text-primary/75 sm:text-sm">
            Capability model
            <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" aria-hidden="true" />
          </NuxtLink>
        </div>
      </div>
    </section>

    <section>
      <div class="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-14 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-12">
        <div>
          <h2 class="max-w-[30ch] text-3xl font-semibold tracking-tight text-highlighted text-balance">
            Build the server layer first. Give the model a door later.
          </h2>
          <p class="mt-4 max-w-[56ch] text-lg text-muted text-pretty sm:text-base/7">
            The primitive docs are the shortest path to something runnable. The Agents docs show how to expose those primitives without leaking the whole backend.
          </p>
        </div>
        <div class="flex shrink-0 flex-col gap-3 sm:flex-row">
          <NuxtLink
            to="/docs/getting-started/first-server-primitive"
            class="inline-flex items-center justify-center gap-2 rounded-sm border border-default px-4 py-3 text-base font-medium text-highlighted hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:text-sm"
          >
            <UIcon name="i-lucide-rocket" class="size-4 shrink-0" aria-hidden="true" />
            First primitive
          </NuxtLink>
          <NuxtLink
            to="/docs/concepts/server-primitives-for-any-host"
            class="inline-flex items-center justify-center gap-2 rounded-sm border border-default px-4 py-3 text-base font-medium text-highlighted hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:text-sm"
          >
            <UIcon name="i-lucide-map" class="size-4 shrink-0" aria-hidden="true" />
            Server model
          </NuxtLink>
        </div>
      </div>
    </section>
  </UMain>
</template>

<style scoped>
.server-signal {
  position: relative;
  overflow: hidden;
}

.server-signal::before {
  content: "";
  position: absolute;
  inset: -40% auto -40% -20%;
  width: 35%;
  background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--ui-primary) 18%, transparent), transparent);
  transform: translateX(-100%) rotate(8deg);
  animation: server-signal-sweep 7s linear infinite;
}

@keyframes server-signal-sweep {
  to {
    transform: translateX(380%) rotate(8deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .server-signal::before {
    animation: none;
  }
}
</style>
