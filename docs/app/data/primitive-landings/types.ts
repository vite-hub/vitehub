export type PrimitiveFramework = "vite" | "nitro" | "nuxt";

export interface PrimitiveProjectFile {
  path: string;
  language: string;
  content: string;
}

export interface PrimitiveProjectVariant {
  framework: PrimitiveFramework;
  label: string;
  illustrative?: boolean;
  files: PrimitiveProjectFile[];
}

export interface PrimitiveLanding {
  slug: string;
  name: string;
  eyebrow: string;
  description: string;
  tagline: string;
  accent: "primary" | "info" | "warning" | "secondary";
  supported: string[];
  variants: PrimitiveProjectVariant[];
  docsTo: string;
}
