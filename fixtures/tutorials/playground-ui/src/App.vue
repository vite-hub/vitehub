<script setup lang="ts">
import { ref } from "vue"
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@ui-sdk/vue/dialog"
import { Field, FieldLabel } from "@ui-sdk/vue/field"
import { Input } from "@ui-sdk/vue/input"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/vue/menu"
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@ui-sdk/vue/tabs"
import { Toast, ToastClose, ToastDescription, ToastRegion, ToastTitle, createToaster } from "@ui-sdk/vue/toast"
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/vue/tooltip"

// Every part comes from @ui-sdk/vue. The parts have behavior, focus, keyboard, and ARIA, and no styles:
// src/style.css styles them through their data-slot and state attributes.
const toast = createToaster()
const members = ref(["Ada Lovelace", "Grace Hopper"])
const inviting = ref(false)
const name = ref("")

function invite() {
  const invited = name.value.trim()
  if (!invited) return
  members.value.push(invited)
  name.value = ""
  inviting.value = false
  toast("Invitation sent", { description: `${invited} can open the project now.` })
}

function act(value: string) {
  toast(`${value} the project`, { description: "The menu ran this action." })
}
</script>

<template>
  <main>
    <header>
      <h1>Launch plan</h1>
      <Tooltip>
        <TooltipTrigger aria-label="Copy the project link" data-variant="ghost" @click="toast('Link copied')">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
        </TooltipTrigger>
        <TooltipContent>Copy the project link</TooltipContent>
      </Tooltip>
      <Menu @action="act">
        <MenuTrigger data-variant="outline">Actions</MenuTrigger>
        <MenuContent>
          <MenuItem value="Renamed">Rename</MenuItem>
          <MenuItem value="Duplicated">Duplicate</MenuItem>
          <MenuSeparator />
          <MenuItem value="Archived">Archive</MenuItem>
        </MenuContent>
      </Menu>
    </header>

    <Tabs default-value="overview">
      <TabsList>
        <TabsTab value="overview">Overview</TabsTab>
        <TabsTab value="members">Members</TabsTab>
        <TabsIndicator />
      </TabsList>
      <TabsPanel value="overview">
        <p>Edit <code>src/App.vue</code> or <code>src/style.css</code>. The preview updates when you save.</p>
        <div data-slot="row">
          <Dialog v-model:open="inviting">
            <DialogTrigger data-variant="solid">Invite a member</DialogTrigger>
            <DialogBackdrop />
            <DialogContent>
              <DialogTitle>Invite a member</DialogTitle>
              <DialogDescription>They can open the project after you invite them.</DialogDescription>
              <form @submit.prevent="invite">
                <Field>
                  <FieldLabel>Name</FieldLabel>
                  <Input v-model="name" autocomplete="off" required />
                </Field>
                <div data-slot="row">
                  <DialogClose data-variant="ghost" type="button">Cancel</DialogClose>
                  <button data-variant="solid" type="submit">Invite</button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
          <button data-variant="outline" type="button" @click="toast('Draft saved', { description: 'Your changes are safe.' })">Save draft</button>
        </div>
      </TabsPanel>
      <TabsPanel value="members">
        <ul>
          <li v-for="member in members" :key="member">{{ member }}</li>
        </ul>
      </TabsPanel>
    </Tabs>

    <ToastRegion :toaster="toast">
      <Toast>
        <ToastTitle />
        <ToastDescription />
        <ToastClose aria-label="Close">×</ToastClose>
      </Toast>
    </ToastRegion>
  </main>
</template>
