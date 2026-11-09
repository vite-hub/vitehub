<script setup lang="ts">
const results = [
  { title: "Caching route rules | nuxt.com", url: "https://nuxt.com/docs/guide/concepts/rendering#route-rules" },
  { title: "Storage layer | nitro.build", url: "https://nitro.build/guide/storage" },
  { title: "Cache keys | developers.cloudflare.com", url: "https://developers.cloudflare.com/cache/how-to/cache-keys/" },
];
</script>

<template>
  <Trace class="w-full max-w-sm">
    <UModal title="Searched the web for cache keys" description="Three results were used in the response.">
      <button type="button">
        <TraceLine>
          <TraceIcon><UIcon name="i-ph-globe-light" /></TraceIcon>
          <TraceTitle>Searched the web for cache keys</TraceTitle>
          <TraceIcon><UIcon name="i-ph-caret-right-light" /></TraceIcon>
        </TraceLine>
      </button>
      <template #body>
        <Trace>
          <a v-for="result in results" :key="result.url" :href="result.url" target="_blank" rel="noreferrer">
            <TraceLine>
              <TraceIcon><UIcon name="i-ph-globe-light" /></TraceIcon>
              <TraceTitle>
                {{ result.title }}
                <span class="sr-only"> (opens in a new tab)</span>
              </TraceTitle>
              <TraceIcon><UIcon name="i-ph-arrow-up-right-light" /></TraceIcon>
            </TraceLine>
          </a>
        </Trace>
      </template>
    </UModal>
  </Trace>
</template>
