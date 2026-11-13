<script setup lang="ts">
import { Field, FieldLabel } from "@vite-hub/kit/field"
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@vite-hub/kit/segmented-control"
</script>

<template>
  <Field>
    <FieldLabel>View</FieldLabel>
    <SegmentedControl default-value="list">
      <SegmentedControlIndicator />
      <SegmentedControlItem value="list">List</SegmentedControlItem>
      <SegmentedControlItem value="grid">Grid</SegmentedControlItem>
      <SegmentedControlItem value="board">Board</SegmentedControlItem>
    </SegmentedControl>
  </Field>
</template>
