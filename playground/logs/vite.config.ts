import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { vitehub } from "vite-hub";

export default defineConfig(({ command }) => ({
  environments: { nitro: { resolve: { external: ["@vite-hub/agent", "vite-hub/agent"] } } },
  plugins: [
    vitehub({
      host: "node",
      console: command === "serve" ? { auth: false, local: true } : false,
      observability: command === "serve"
        ? {
            logs: true,
            evlog: {
              env: { service: "logs-playground" },
              redact: { paths: ["customer.email"] },
              exclude: ["/_vitehub/**", "/api/_vitehub/**"],
            },
          }
        : false,
    }),
    nitro({ serverDir: "./server" }),
  ],
}));
