import { createDummyMessage } from "@vitehub/dummy";

export async function runDummyBuild() {
  return createDummyMessage({ label: "vite build example" });
}
