<script setup lang="ts">
import { Field, FieldLabel } from "@vite-hub/kit/field"
import { Textarea } from "@vite-hub/kit/textarea"
</script>

<template>
  <Field name="message">
    <FieldLabel>Message</FieldLabel>
    <Textarea placeholder="Type your message here…" />
  </Field>
</template>
