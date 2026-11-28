<script lang="ts">
import type { Component } from "vue";

export interface AppShellLink {
  title: string;
  href: string;
}

export interface AppShellItem extends Partial<AppShellLink> {
  title: string;
  icon?: Component;
  badge?: string | number;
  children?: AppShellLink[];
}

export interface AppShellGroup {
  label?: string;
  items: AppShellItem[];
}
</script>

<script setup lang="ts">
import { ChevronRightIcon } from "@lucide/vue";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/vue/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
  sidebarMenuButtonVariants,
} from "@/components/ui/sidebar";

const props = withDefaults(
  defineProps<{
    title: string;
    heading?: string;
    groups: AppShellGroup[];
    current?: string;
    link?: string | Component;
  }>(),
  { link: "a" },
);
const open = defineModel<boolean>("open", { default: true });

const isCurrent = (href?: string) => href !== undefined && href === props.current;
const hasCurrent = (item: AppShellItem) => item.children?.some((child) => isCurrent(child.href)) ?? false;
</script>

<template>
  <SidebarProvider v-model:open="open">
    <Sidebar>
      <SidebarHeader>
        <div class="flex h-8 min-w-0 items-center gap-2 px-2">
          <slot name="logo" />
          <span class="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">{{ props.title }}</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup v-for="(group, index) in props.groups" :key="group.label ?? index">
          <SidebarGroupLabel v-if="group.label">{{ group.label }}</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem v-for="item in group.items" :key="item.title">
              <Collapsible v-if="item.children" class="group/collapsible" :default-open="hasCurrent(item)">
                <CollapsibleTrigger :class="sidebarMenuButtonVariants()" data-focus-inset="">
                  <component :is="item.icon" v-if="item.icon" aria-hidden="true" />
                  <span>{{ item.title }}</span>
                  <ChevronRightIcon
                    aria-hidden="true"
                    class="ms-auto text-muted-foreground transition-transform duration-200 ease-out group-data-open/collapsible:rotate-90 group-data-[collapsible=icon]:hidden motion-reduce:transition-none rtl:rotate-180"
                  />
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem v-for="child in item.children" :key="child.href">
                      <SidebarMenuSubButton :as="props.link" :href="child.href" :is-active="isCurrent(child.href)">
                        <span>{{ child.title }}</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </CollapsiblePanel>
              </Collapsible>
              <template v-else>
                <SidebarMenuButton :as="props.link" :href="item.href" :is-active="isCurrent(item.href)" :title="item.title">
                  <component :is="item.icon" v-if="item.icon" aria-hidden="true" />
                  <span>{{ item.title }}</span>
                </SidebarMenuButton>
                <SidebarMenuBadge v-if="item.badge !== undefined">{{ item.badge }}</SidebarMenuBadge>
              </template>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter v-if="$slots.footer">
        <slot name="footer" />
      </SidebarFooter>
    </Sidebar>
    <SidebarInset>
      <header class="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger />
        <div class="h-4 w-px bg-border" aria-hidden="true" />
        <slot name="header">
          <h1 class="m-0 min-w-0 truncate text-sm font-medium">{{ props.heading }}</h1>
        </slot>
        <div class="ms-auto flex items-center gap-1">
          <slot name="actions" />
        </div>
      </header>
      <div class="flex min-w-0 flex-1 flex-col p-4 md:p-6">
        <slot />
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
