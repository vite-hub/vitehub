<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogTrigger } from "reka-ui";
</script>

<template>
  <DialogRoot>
    <DialogTrigger>Open settings</DialogTrigger>
    <DialogPortal>
      <DialogOverlay style="position: fixed; inset: 0; background: rgb(0 0 0 / 0.3)" />
      <DialogContent style="position: fixed; top: 200px; left: 200px; width: 300px; padding: 16px; background: white">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Change the session settings.</DialogDescription>
        <label>Name <input name="name"></label>
        <button type="button">Save</button>
        <DialogClose>Close</DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <button type="button">After</button>
</template>
