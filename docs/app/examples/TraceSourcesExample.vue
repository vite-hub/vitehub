<script setup lang="ts">
const sources = [
  { href: "https://nuxt.com/docs/getting-started/installation", title: "Installation | nuxt.com" },
  { href: "https://www.npmjs.com/package/nuxi", title: "nuxi | npmjs.com" },
  { href: "https://pnpm.io/settings#minimumreleaseage", title: "Settings: minimumReleaseAge | pnpm.io" },
];
</script>

<template>
  <div class="w-full max-w-sm">
    <TraceCollapsible default-open>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><UIcon name="i-ph-globe-light" /></TraceIcon>
          <TraceTitle>Used {{ sources.length }} sources</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          <a v-for="source in sources" :key="source.href" :href="source.href" target="_blank" rel="noreferrer">
            <TraceLine>
              <TraceIcon><UIcon name="i-ph-globe-light" /></TraceIcon>
              <TraceTitle>
                {{ source.title }}
                <span class="sr-only"> (opens in a new tab)</span>
              </TraceTitle>
              <TraceIcon><UIcon name="i-ph-arrow-up-right-light" /></TraceIcon>
            </TraceLine>
          </a>
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  </div>
</template>
