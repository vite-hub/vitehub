import { openSiteLink } from "../../../utils/site-access.ts"

export default { fetch: (request: Request) => openSiteLink(request, "comments") }
