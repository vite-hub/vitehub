<script setup lang="ts">
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarSeparator, SidebarTrigger } from "../sidebar/index.ts";
import { Box, House, Rocket, Settings } from "@lucide/vue";
</script>

<template>
  <!-- `contain: layout` keeps the fixed sidebar inside this frame. -->
  <div
    data-slot="example-sidebar"
    style="contain: layout; height: 28rem; overflow: hidden; border: 1px solid var(--border); border-radius: 12px"
  >
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenuButton size="lg"><Box aria-hidden="true" /><span>My app</span></SidebarMenuButton>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel label="Project" />
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton href="#overview" is-active><House aria-hidden="true" /><span>Overview</span></SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton href="#deploys"><Rocket aria-hidden="true" /><span>Deploys</span></SidebarMenuButton>
                <SidebarMenuBadge>12</SidebarMenuBadge>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarSeparator />
        <SidebarFooter>
          <SidebarMenuButton><Settings aria-hidden="true" /><span>Settings</span></SidebarMenuButton>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header data-slot="example-sidebar-header" style="display: flex; align-items: center; height: 3rem; padding-inline: 0.75rem">
          <SidebarTrigger />
        </header>
        <p style="padding: 1rem; margin: 0">Overview</p>
      </SidebarInset>
    </SidebarProvider>
  </div>
</template>
