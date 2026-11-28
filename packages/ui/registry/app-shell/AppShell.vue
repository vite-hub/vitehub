<script setup lang="ts">
import "./app-shell.css";
import { ChevronRight } from "@lucide/vue";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/vue/collapsible";
import { reactive } from "vue";
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
} from "../sidebar/index.ts";
import type { AppShellEmits, AppShellItem, AppShellProps, AppShellSlots } from "./types.ts";

const { title, heading, groups, current, link, defaultCollapsed = false } = defineProps<AppShellProps>();
const collapsed = defineModel<boolean | undefined>("collapsed", { default: undefined });
defineEmits<AppShellEmits>();
defineSlots<AppShellSlots>();

const openGroups = reactive(new WeakMap<AppShellItem, boolean>());

function isCurrent(href?: string) {
  return href !== undefined && href === current;
}

function hasCurrent(item: AppShellItem) {
  return item.children?.some((child) => isCurrent(child.href)) ?? false;
}

function setGroupOpen(item: AppShellItem, open: boolean, isMobile: boolean) {
  if (!isMobile && (collapsed.value ?? defaultCollapsed)) {
    collapsed.value = false;
    openGroups.set(item, true);
    return;
  }
  openGroups.set(item, open);
}

function closeOnNavigation(event: MouseEvent, href: string | undefined, closeMobile: () => void) {
  if (href === undefined || event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.currentTarget;
  if (target instanceof HTMLAnchorElement && (target.hasAttribute("download") || (target.target && target.target.toLowerCase() !== "_self"))) return;
  closeMobile();
}
</script>

<template>
  <div data-slot="app-shell">
    <SidebarProvider v-slot="{ isMobile, closeMobile }" v-model:collapsed="collapsed" :default-collapsed="defaultCollapsed || undefined">
      <Sidebar>
        <SidebarHeader>
          <div data-slot="app-shell-brand">
            <slot name="logo" />
            <span data-slot="app-shell-title">{{ title }}</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup v-for="(group, index) in groups" :key="group.label ?? index">
            <SidebarGroupLabel v-if="group.label" :label="group.label" />
            <SidebarMenu>
              <SidebarMenuItem v-for="item in group.items" :key="item.title">
                <Collapsible
                  v-if="item.children"
                  :open="openGroups.get(item) ?? hasCurrent(item)"
                  @update:open="setGroupOpen(item, $event, isMobile)"
                >
                  <template #render="{ props: part, children }">
                    <div v-bind="part" data-slot="app-shell-group"><component :is="children" /></div>
                  </template>
                  <CollapsibleTrigger :title="item.title">
                    <template #render="{ props: part, children }">
                      <button v-bind="part" data-slot="sidebar-menu-button"><component :is="children" /></button>
                    </template>
                    <component :is="item.icon" v-if="item.icon" aria-hidden="true" />
                    <span>{{ item.title }}</span>
                    <ChevronRight data-slot="app-shell-chevron" aria-hidden="true" />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <template #render="{ props: part, children }">
                      <div v-bind="part" data-slot="app-shell-group-panel"><component :is="children" /></div>
                    </template>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem v-for="child in item.children" :key="child.href">
                        <SidebarMenuSubButton :href="child.href" :is-active="isCurrent(child.href)" @click.capture="isMobile && closeOnNavigation($event, child.href, closeMobile)">
                          <template v-if="link" #render="{ props: row }">
                            <component :is="link" v-bind="row" :to="child.href">
                              <span>{{ child.title }}</span>
                            </component>
                          </template>
                          <span>{{ child.title }}</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </CollapsiblePanel>
                </Collapsible>
                <template v-else>
                  <SidebarMenuButton :href="item.href" :is-active="isCurrent(item.href)" :title="item.title" @click.capture="isMobile && closeOnNavigation($event, item.href, closeMobile)">
                    <template v-if="link" #render="{ props: row }">
                      <component :is="link" v-bind="row" :to="item.href">
                        <component :is="item.icon" v-if="item.icon" aria-hidden="true" />
                        <span>{{ item.title }}</span>
                      </component>
                    </template>
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
        <header data-slot="app-shell-header">
          <SidebarTrigger />
          <div data-slot="app-shell-divider" aria-hidden="true" />
          <slot name="header">
            <h1 data-slot="app-shell-heading">{{ heading }}</h1>
          </slot>
          <div data-slot="app-shell-actions">
            <slot name="actions" />
          </div>
        </header>
        <div data-slot="app-shell-body">
          <slot />
        </div>
      </SidebarInset>
    </SidebarProvider>
  </div>
</template>
