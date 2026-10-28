import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { usePublicEnv } from "#vitehub/env/public";
import { useServerEnv } from "#vitehub/env/server";

const publicEnv = usePublicEnv();
const serverEnv = useServerEnv();
const clientRoot = fileURLToPath(new URL("../client/", import.meta.url));

const server = createServer(async (request, response) => {
  if (request.url !== "/api/config") {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = resolve(clientRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${clientRoot.replace(/\/$/, "")}${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.setHeader(
        "content-type",
        file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      );
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      public: publicEnv,
      runtime: {
        retries: serverEnv.retries,
        dryRun: serverEnv.dryRun,
        mode: serverEnv.mode,
        serviceUrl: serverEnv.serviceUrl,
        timeout: serverEnv.timeout,
        label: serverEnv.label,
        roles: serverEnv.roles,
        settings: serverEnv.settings,
        metadata: serverEnv.metadata,
      },
      tokenConfigured: serverEnv.apiToken.unseal().length > 0,
      tokenRedacted: String(serverEnv.apiToken),
    }),
  );
});

server.listen(Number(process.env.ENV_SCHEMA_LAB_PORT ?? 4317), "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    console.log(`ENV_SCHEMA_LAB_LISTENING http://127.0.0.1:${address.port}`);
});

process.once("SIGTERM", () => server.close());
