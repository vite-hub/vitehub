<script setup lang="ts">
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@vite-hub/kit/dialog"
import { Field, FieldLabel } from "@vite-hub/kit/field"
import { Input } from "@vite-hub/kit/input"
import { XIcon } from "../icons"
</script>

<template>
  <Dialog default-open>
    <DialogTrigger>Share</DialogTrigger>
    <DialogBackdrop />
    <DialogContent>
      <div data-slot="stack">
        <DialogTitle>Share link</DialogTitle>
        <DialogDescription
          >Anyone who has this link will be able to view
          this.</DialogDescription
        >
      </div>
      <Field>
        <FieldLabel>Link</FieldLabel>
        <Input defaultValue="https://example.com/project" readonly />
      </Field>
      <div data-slot="row">
        <DialogClose data-variant="solid">Done</DialogClose>
      </div>
      <DialogClose aria-label="Close">
        <XIcon aria-hidden="true" />
      </DialogClose>
    </DialogContent>
  </Dialog>
</template>
