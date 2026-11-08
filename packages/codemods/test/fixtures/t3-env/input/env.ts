import { createEnv } from "@t3-oss/env-nuxt";
import { z } from "zod";

export const env = createEnv({
  client: {
    NUXT_PUBLIC_APP_URL: z.url(),
  },
  server: {
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    DATABASE_URL: z.url(),
    SMTP_PORT: z.coerce.number(),
    SMTP_PASS: z.string().min(1),
    MOCK_EMAIL: z.string().transform((value) => value === "true").optional(),
    TIMEOUT: z.union([z.string(), z.number()]),
  },
  skipValidation: !!process.env.CI,
});
