import { defineEventHandler, HTTPError, readBody } from "h3"
import { forecast } from "../utils/forecast-choices"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text?: string }>(event)
  const [error, selection] = await forecast.resolve(body?.text ?? "")
  if (error) throw new HTTPError({ status: 422, message: error.message })
  return selection
})
