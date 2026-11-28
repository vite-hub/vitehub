export { default as Sidebar } from "./Sidebar.vue";
export { default as SidebarContent } from "./SidebarContent.vue";
export { default as SidebarFooter } from "./SidebarFooter.vue";
export { default as SidebarGroup } from "./SidebarGroup.vue";
export { default as SidebarGroupLabel } from "./SidebarGroupLabel.vue";
export { default as SidebarHeader } from "./SidebarHeader.vue";
export { default as SidebarInset } from "./SidebarInset.vue";
export { default as SidebarMenu } from "./SidebarMenu.vue";
export { default as SidebarMenuBadge } from "./SidebarMenuBadge.vue";
export { default as SidebarMenuButton } from "./SidebarMenuButton.vue";
export { default as SidebarMenuItem } from "./SidebarMenuItem.vue";
export { default as SidebarMenuSub } from "./SidebarMenuSub.vue";
export { default as SidebarMenuSubButton } from "./SidebarMenuSubButton.vue";
export { default as SidebarMenuSubItem } from "./SidebarMenuSubItem.vue";
export { default as SidebarProvider } from "./SidebarProvider.vue";
export { default as SidebarSeparator } from "./SidebarSeparator.vue";
export { default as SidebarTrigger } from "./SidebarTrigger.vue";
export { sidebarKey, useSidebar } from "./utils";
export type { SidebarContext } from "./utils";

const row = "flex w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md border-0 bg-transparent px-2 text-start text-sm text-sidebar-foreground no-underline transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50 disabled:pointer-events-none disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0";

export function sidebarMenuButtonVariants(): string {
  return `${row} h-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>svg:first-child]:text-muted-foreground data-active:[&>svg:first-child]:text-sidebar-accent-foreground`;
}

export function sidebarMenuSubButtonVariants(): string {
  return `${row} h-7 text-muted-foreground`;
}
