<script setup lang="ts">
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../empty/index.ts";
import { Button } from "../button/index.ts";
import { FolderOpen } from "@lucide/vue";
</script>

<template>
  <div data-slot="example-empty" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Empty variant="outline">
      <EmptyHeader>
        <EmptyMedia><FolderOpen aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>No projects yet</EmptyTitle>
        <EmptyDescription>Deploy an app to see it here.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="solid" size="sm" label="New project" />
      </EmptyContent>
    </Empty>
  </div>
</template>
