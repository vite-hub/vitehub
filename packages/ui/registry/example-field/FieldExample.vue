<script setup lang="ts">
import { Field, FieldDescription, FieldError, FieldLabel } from "../field/index.ts";
import { Input } from "../input/index.ts";
</script>

<template>
  <div data-slot="example-field" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Field name="project">
      <FieldLabel label="Project name" />
      <Input placeholder="my-app" />
      <FieldDescription>Lowercase letters, digits, and dashes.</FieldDescription>
    </Field>
    <Field name="domain" invalid>
      <FieldLabel label="Domain" />
      <Input default-value="not a domain" />
      <FieldError>Enter a domain such as app.example.com.</FieldError>
    </Field>
  </div>
</template>
