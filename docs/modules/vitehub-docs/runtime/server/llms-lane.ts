import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { createLaneLlmsText, laneFromLlmsSegment } from "../utils/lane-llms";
import { docsManifest } from "../utils/docs";

export default defineEventHandler((event) => {
  const lane = laneFromLlmsSegment(getRouterParam(event, "lane"));
  if (!lane) throw createError({ statusCode: 404, statusMessage: "Page not found" });

  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");
  return createLaneLlmsText(docsManifest, lane);
});
