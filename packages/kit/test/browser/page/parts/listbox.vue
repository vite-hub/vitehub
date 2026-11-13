<script setup lang="ts">
import { CheckIcon } from "../icons"
import { Field, FieldDescription, FieldLabel } from "@vite-hub/kit/field"
import { Listbox, ListboxItem, ListboxItemIndicator } from "@vite-hub/kit/listbox"

const topics = [
  { value: "comments", label: "Comments" },
  { value: "mentions", label: "Mentions" },
  { value: "reactions", label: "Reactions" },
  { value: "sign-ins", label: "New sign-ins" },
  { value: "billing", label: "Billing" },
]
</script>

<template>
  <Field>
    <FieldLabel>Email me about</FieldLabel>
    <Listbox multiple activation="automatic" :default-value="['mentions']">
      <ListboxItem
        v-for="topic in topics"
        :key="topic.value"
        :value="topic.value"
      >
        {{ topic.label }}
        <ListboxItemIndicator>
          <CheckIcon aria-hidden="true" />
        </ListboxItemIndicator>
      </ListboxItem>
    </Listbox>
    <FieldDescription
      >Hold Shift to select a range, or Ctrl or ⌘ to add one.</FieldDescription
    >
  </Field>
</template>
