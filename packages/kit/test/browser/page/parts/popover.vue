<script setup lang="ts">
import { Field, FieldLabel } from "@vite-hub/kit/field"
import { Input } from "@vite-hub/kit/input"
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@vite-hub/kit/popover"
</script>

<template>
  <Popover>
    <PopoverTrigger>Share</PopoverTrigger>
    <PopoverContent>
      <PopoverTitle>Share this document</PopoverTitle>
      <PopoverDescription>Anyone with the link can view it.</PopoverDescription>
      <Field>
        <FieldLabel>Link</FieldLabel>
        <Input readonly default-value="acme.app/d/q3-roadmap" />
      </Field>
      <div data-slot="row">
        <PopoverClose>Cancel</PopoverClose>
        <PopoverClose data-variant="solid">Copy Link</PopoverClose>
      </div>
    </PopoverContent>
  </Popover>
</template>
