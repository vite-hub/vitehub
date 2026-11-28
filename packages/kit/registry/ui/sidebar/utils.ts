import { inject } from "vue";
import type { InjectionKey, Ref } from "vue";

export interface SidebarContext {
  open: Ref<boolean>;
  openMobile: Ref<boolean>;
  isMobile: Ref<boolean>;
  state: Readonly<Ref<"expanded" | "collapsed">>;
  toggle: () => void;
}

export const sidebarKey: InjectionKey<SidebarContext> = Symbol("sidebar");

export function useSidebar(): SidebarContext {
  const context = inject(sidebarKey);
  if (!context) throw new Error("useSidebar() needs a <SidebarProvider> above it.");
  return context;
}
