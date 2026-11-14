import content from "../content"

export default defineEventHandler(() => content.collection("docs").list())
