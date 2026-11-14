<script setup lang="ts">
import { Button } from "@ui-sdk/vue/button"
import { MinusIcon, PlusIcon } from "../icons"
import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "@ui-sdk/vue/drawer"
import { ref } from "vue"
const goal = { initial: 350, min: 200, max: 400, step: 10 }

const calories = ref(goal.initial)
</script>

<template>
  <Drawer default-open>
    <DrawerTrigger>Open Drawer</DrawerTrigger>
    <DrawerBackdrop />
    <DrawerContent>
      <div data-slot="grip" aria-hidden="true" />

      <div data-slot="stack">
        <DrawerTitle>Move goal</DrawerTitle>
        <DrawerDescription>Set your daily activity goal.</DrawerDescription>
      </div>

      <div data-slot="row">
        <Button
          aria-label="Decrease"
          :disabled="calories <= goal.min"
          @click="calories -= goal.step"
        >
          <MinusIcon aria-hidden="true" />
        </Button>
        <div data-slot="stack">
          <div aria-live="polite">{{ calories }}</div>
          <div data-slot="hint">Calories/day</div>
        </div>
        <Button
          aria-label="Increase"
          :disabled="calories >= goal.max"
          @click="calories += goal.step"
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </div>

      <div data-slot="stack">
        <DrawerClose data-variant="solid" value="submit">Submit</DrawerClose>
        <DrawerClose>Cancel</DrawerClose>
      </div>
    </DrawerContent>
  </Drawer>
</template>
