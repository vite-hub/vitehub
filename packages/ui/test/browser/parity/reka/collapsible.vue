<script setup lang="ts">
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui";
</script>

<template>
  <button type="button">Before</button>
  <CollapsibleRoot>
    <CollapsibleTrigger>Show details</CollapsibleTrigger>
    <CollapsibleContent>
      <p>Trace details</p>
      <button type="button">Copy trace</button>
    </CollapsibleContent>
  </CollapsibleRoot>
  <button type="button">After</button>
</template>
