const usageModeDefs = [
  { id: "dev", label: "Dev", description: "Local development flow", icon: "i-lucide-wrench" },
  { id: "build", label: "Build", description: "Production build flow", icon: "i-lucide-hammer" },
] as const;

export type UsageMode = (typeof usageModeDefs)[number]["id"];

export const usageModes = usageModeDefs.map(entry => entry.id) as UsageMode[];
export const defaultUsageMode: UsageMode = "dev";
