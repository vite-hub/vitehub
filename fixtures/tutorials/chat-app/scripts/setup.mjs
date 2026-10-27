import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const env = example
  .replace("CHAT_PASSWORD=", `CHAT_PASSWORD=${randomBytes(24).toString("hex")}`)
  .replace("CHAT_SESSION_SECRET=", `CHAT_SESSION_SECRET=${randomBytes(32).toString("hex")}`);
writeFileSync(new URL("../.env", import.meta.url), env, { flag: "wx", mode: 0o600 });
console.log("Created .env. Open it to read your owner password. Existing .env files are never replaced.");
