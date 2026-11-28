<script setup lang="ts">
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../dialog/index.ts";
import { Input } from "../input/index.ts";
</script>

<template>
  <div data-slot="example-dialog" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <Dialog>
      <DialogTrigger>Rename project</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>The URL of the project changes too.</DialogDescription>
        </DialogHeader>
        <Input aria-label="Project name" default-value="my-app" />
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
