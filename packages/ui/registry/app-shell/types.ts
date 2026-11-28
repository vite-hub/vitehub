import type { Component } from "vue";

export interface AppShellLink {
  title: string;
  href: string;
}

export interface AppShellItem {
  title: string;
  href?: string;
  icon?: Component;
  badge?: string | number;
  children?: AppShellLink[];
}

export interface AppShellGroup {
  label?: string;
  items: AppShellItem[];
}

export interface AppShellProps {
  title: string;
  heading?: string;
  groups: AppShellGroup[];
  current?: string;
  link?: Component;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
}

export interface AppShellEmits {
  "update:collapsed": [collapsed: boolean];
}

export interface AppShellSlots {
  default?: () => unknown;
  logo?: () => unknown;
  header?: () => unknown;
  actions?: () => unknown;
  footer?: () => unknown;
}
