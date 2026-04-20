const frameworkDefs = [
  { id: "vite", label: "Vite", description: "Plugin only", icon: "i-simple-icons-vite", colorIcon: "i-logos-vitejs" },
  { id: "nitro", label: "Nitro v3", description: "Server runtime", icon: "i-brand-nitro", colorIcon: "i-unjs-nitro" },
  { id: "nuxt", label: "Nuxt v5", description: "Full-stack app", icon: "i-simple-icons-nuxtdotjs", colorIcon: "i-logos-nuxt-icon" },
] as const;

export type Framework = (typeof frameworkDefs)[number]["id"];

export const frameworks = frameworkDefs.map(entry => entry.id) as Framework[];
export const defaultFramework: Framework = "nuxt";
export const frameworkPattern = frameworks.join("|");

export const frameworkLabels = Object.fromEntries(
  frameworkDefs.map(entry => [entry.id, entry.label]),
) as Record<Framework, string>;

const frameworkIcons = Object.fromEntries(
  frameworkDefs.map(entry => [entry.id, entry.icon]),
) as Record<Framework, string>;

export const frameworkColorIcons = Object.fromEntries(
  frameworkDefs.map(entry => [entry.id, entry.colorIcon]),
) as Record<Framework, string>;

export const frameworkDescriptions = Object.fromEntries(
  frameworkDefs.map(entry => [entry.id, entry.description]),
) as Record<Framework, string>;
