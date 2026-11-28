<script setup lang="ts">
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "../sheet/index.ts";
</script>

<template>
  <div data-slot="example-sheet" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <Sheet>
      <SheetTrigger>Open settings</SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Change the project settings.</SheetDescription>
        </SheetHeader>
        <p v-for="line in 40" :key="line" data-slot="example-sheet-line">Setting {{ line }}</p>
        <SheetFooter>
          <SheetClose>Done</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  </div>
</template>
