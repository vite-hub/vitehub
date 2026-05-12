import { cloudflareCIProvider } from "./providers/cloudflare.ts"
import { githubCIProvider } from "./providers/github.ts"
import { vercelCIProvider } from "./providers/vercel.ts"
import type { CIProvider, CIProviderID } from "./types.ts"

export function createCIProvider(id: CIProviderID): CIProvider {
  switch (id) {
    case "cloudflare":
      return cloudflareCIProvider
    case "github":
      return githubCIProvider
    case "vercel":
      return vercelCIProvider
  }
}

