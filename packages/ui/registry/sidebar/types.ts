export interface SidebarProviderProps {
  collapsed?: boolean;
  defaultCollapsed?: boolean;
}

export interface SidebarProviderEmits {
  "update:collapsed": [collapsed: boolean];
}

export interface SidebarProviderSlots {
  default?: (props: { isMobile: boolean; closeMobile: () => void }) => unknown;
}

export interface SidebarProps {
  side?: "left" | "right";
  collapsible?: "icon" | "offcanvas" | "none";
  label?: string;
}

export interface SidebarSlots {
  default?: () => unknown;
}

export interface SidebarTriggerProps {
  label?: string;
}

export interface SidebarTriggerSlots {
  icon?: () => unknown;
}

export interface SidebarGroupLabelProps {
  label?: string;
}

export interface SidebarMenuButtonProps {
  href?: string;
  isActive?: boolean;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
}

export interface SidebarMenuSubButtonProps {
  href?: string;
  isActive?: boolean;
  disabled?: boolean;
}

export interface SidebarMenuButtonRenderProps {
  "data-slot": string;
  "data-active"?: string;
  "data-size"?: string;
  "aria-current"?: "page";
  href?: string;
}

export interface SidebarMenuButtonSlots {
  default?: () => unknown;
  render?: (scope: { props: SidebarMenuButtonRenderProps }) => unknown;
}

export interface SidebarMenuSubButtonSlots {
  default?: () => unknown;
  render?: (scope: { props: SidebarMenuButtonRenderProps }) => unknown;
}

export interface SidebarInsetSlots {
  default?: () => unknown;
}

export interface SidebarHeaderSlots {
  default?: () => unknown;
}

export interface SidebarContentSlots {
  default?: () => unknown;
}

export interface SidebarFooterSlots {
  default?: () => unknown;
}

export interface SidebarGroupSlots {
  default?: () => unknown;
}

export interface SidebarGroupContentSlots {
  default?: () => unknown;
}

export interface SidebarMenuSlots {
  default?: () => unknown;
}

export interface SidebarMenuItemSlots {
  default?: () => unknown;
}

export interface SidebarMenuBadgeSlots {
  default?: () => unknown;
}

export interface SidebarMenuSubSlots {
  default?: () => unknown;
}

export interface SidebarMenuSubItemSlots {
  default?: () => unknown;
}

export interface SidebarGroupLabelSlots {
  default?: () => unknown;
}
