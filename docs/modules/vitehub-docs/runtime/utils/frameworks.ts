const frameworkDefs = [
  { id: "vite", label: "Vite", description: "Plugin only", icon: "i-simple-icons-vite", colorIcon: "i-logos-vitejs" },
] as const;

export type Framework = (typeof frameworkDefs)[number]["id"];

export const frameworks = frameworkDefs.map(entry => entry.id) as Framework[];
export const defaultFramework: Framework = "vite";
