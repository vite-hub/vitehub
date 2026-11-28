<script setup lang="ts">
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "../command/index.ts";
import { DialogTrigger } from "../dialog/index.ts";
import { Rocket, ScrollText } from "@lucide/vue";
import { ref } from "vue";

const open = ref(false);
const last = ref("");
</script>

<template>
  <div data-slot="example-command" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Command @action="last = $event.value">
      <CommandInput />
      <CommandList>
        <CommandEmpty />
        <CommandGroup heading="Project">
          <CommandItem value="deploy"><Rocket aria-hidden="true" />Deploy</CommandItem>
          <CommandItem value="logs" shortcut="mod+l"><ScrollText aria-hidden="true" />Open logs<CommandShortcut /></CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Account">
          <CommandItem value="sign-out">Sign out</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
    <CommandDialog v-model:open="open" @action="last = $event.value">
      <template #trigger><DialogTrigger>Open palette</DialogTrigger></template>
      <CommandInput />
      <CommandList>
        <CommandEmpty />
        <CommandItem value="deploy">Deploy</CommandItem>
        <CommandItem value="rollback">Roll back</CommandItem>
      </CommandList>
    </CommandDialog>
    <output data-slot="example-command-last">{{ last }}</output>
  </div>
</template>
