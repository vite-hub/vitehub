<script setup lang="ts">
import { CheckIcon } from "../icons"
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@vite-hub/kit/menu"
</script>

<template>
  <Menu default-open>
    <MenuTrigger>Actions</MenuTrigger>
    <MenuContent>
      <MenuGroup>
        <MenuGroupLabel>Project</MenuGroupLabel>
        <MenuItem value="rename" shortcut="mod+r">Rename</MenuItem>
        <MenuItem value="duplicate" shortcut="mod+d">Duplicate</MenuItem>
        <MenuItem value="archive" disabled>Archive</MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuCheckboxItem value="pinned" default-checked>
        <MenuItemIndicator keep-mounted><CheckIcon aria-hidden="true" /></MenuItemIndicator>
        Pinned
      </MenuCheckboxItem>
      <MenuRadioGroup default-value="list">
        <MenuRadioItem value="list">
          <MenuItemIndicator keep-mounted><CheckIcon aria-hidden="true" /></MenuItemIndicator>
          List view
        </MenuRadioItem>
        <MenuRadioItem value="grid">
          <MenuItemIndicator keep-mounted><CheckIcon aria-hidden="true" /></MenuItemIndicator>
          Grid view
        </MenuRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem value="delete" data-destructive>Delete</MenuItem>
    </MenuContent>
  </Menu>
</template>
