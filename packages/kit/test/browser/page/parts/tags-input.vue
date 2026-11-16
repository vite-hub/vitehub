<script setup lang="ts">
import { ref } from "vue"
import { XIcon } from "../icons"
import { Field, FieldLabel } from "@ui-sdk/vue/field"
import {
  TagsInput,
  TagsInputClear,
  TagsInputInput,
  TagsInputItem,
  TagsInputItemDelete,
  TagsInputItemText,
} from "@vite-hub/kit/tags-input"

const tags = ref(["vue", "nuxt", "vite"])
</script>

<template>
  <Field>
    <FieldLabel>Stack</FieldLabel>
    <TagsInput v-model="tags" name="stack">
      <TagsInputItem v-for="tag in tags" :key="tag" :value="tag">
        <TagsInputItemText>{{ tag }}</TagsInputItemText>
        <TagsInputItemDelete>
          <XIcon aria-hidden="true" />
          <span data-slot="visually-hidden">Remove</span>
        </TagsInputItemDelete>
      </TagsInputItem>
      <TagsInputInput aria-label="Stack" placeholder="Add a tag…" />
      <TagsInputClear>Clear</TagsInputClear>
    </TagsInput>
  </Field>
</template>
