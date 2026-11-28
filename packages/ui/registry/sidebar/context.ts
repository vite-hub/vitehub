import { inject } from "vue";
import type { InjectionKey, Ref } from "vue";

export interface SidebarContext {
  collapsed: Ref<boolean>;
  openMobile: Ref<boolean>;
  isMobile: Ref<boolean>;
  toggle: () => void;
}

export const sidebarKey: InjectionKey<SidebarContext> = Symbol("vitehub-sidebar");

export function useSidebar(): SidebarContext {
  const context = inject(sidebarKey, null);
  if (!context) throw new Error("useSidebar() needs a <SidebarProvider> above it. Wrap the layout in <SidebarProvider>.");
  return context;
}
