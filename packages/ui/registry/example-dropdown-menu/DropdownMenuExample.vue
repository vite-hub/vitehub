<script setup lang="ts">
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../dropdown-menu/index.ts";
import { ScrollText, Settings, Trash2 } from "@lucide/vue";
import { ref } from "vue";

const preview = ref(true);
const region = ref("auto");
</script>

<template>
  <div data-slot="example-dropdown-menu" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <DropdownMenu>
      <DropdownMenuTrigger>Project</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup label="Project">
          <DropdownMenuItem value="settings"><Settings aria-hidden="true" />Settings<DropdownMenuShortcut>⌘,</DropdownMenuShortcut></DropdownMenuItem>
          <DropdownMenuItem value="logs"><ScrollText aria-hidden="true" />Logs</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem v-model:checked="preview" value="preview">Preview deploys</DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup v-model="region">
          <DropdownMenuRadioItem value="auto">Any region</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="eu">Europe</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Share</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem value="link">Copy link</DropdownMenuItem>
            <DropdownMenuItem value="email">Email</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem value="delete" destructive><Trash2 aria-hidden="true" />Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
