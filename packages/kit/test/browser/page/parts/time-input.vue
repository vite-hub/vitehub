<script setup lang="ts">
import { Field, FieldLabel } from "@vite-hub/kit/field"
import { TimeInput } from "@vite-hub/kit/time-input"
</script>

<template>
  <Field>
    <FieldLabel>Meeting time</FieldLabel>
    <TimeInput default-value="09:30" />
  </Field>
</template>
