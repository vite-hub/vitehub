<script setup lang="ts">
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@vite-hub/kit/collapsible";
</script>

<template>
  <button type="button">Before</button>
  <Collapsible>
    <CollapsibleTrigger>Show details</CollapsibleTrigger>
    <CollapsiblePanel>
      <p>Trace details</p>
      <button type="button">Copy trace</button>
    </CollapsiblePanel>
  </Collapsible>
  <button type="button">After</button>
</template>
