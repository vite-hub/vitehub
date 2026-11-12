import { consoleState } from "../../internal.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { ConsoleBlobInspection, ConsoleMediaLibrary } from "../../internal.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import { consoleRequestError } from "./request.ts"

export function installConsoleBlob(
  projectRoot: string,
  storage: BlobStorage,
  stores: readonly string[] = ["default"],
): ConsoleBlobInspection {
  const installedStores = [...new Set(stores.filter(store => store.length > 0))]
    .filter(store => store !== "default")
    .sort()
  installedStores.unshift("default")
  return consoleState().blob = {
    // Blob can be enabled without a document editor, whose media library stays out of that build.
    ...(import.meta.viteHubConsoleDocuments === false ? {} : { media: () => import("./media.ts") }),
    storage,
    stores: installedStores,
  }
}

/** The media library of a build with Blob. Throws a 404 Console error in a build without it. */
export async function loadConsoleMedia(): Promise<ConsoleMediaLibrary> {
  const media = consoleState().blob?.media
  if (!media) throw consoleRequestError(404, "The media library needs Blob. Enable Blob in the ViteHub config.")
  return await media()
}

export function getConsoleBlob(): ConsoleBlobInspection {
  const inspection = consoleState().blob
  if (!inspection) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0049({ message: "[vitehub] Blob inspection has not been installed for this runtime." })
  }
  return inspection
}
