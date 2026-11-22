import { createServer } from "node:http"

const timeZone = "Europe/Madrid"

createServer((request, response) => {
  const time = new Date().toLocaleTimeString("en-GB", { timeZone })
  response.setHeader("content-type", "text/html; charset=utf-8")
  response.end(`<!doctype html><title>Clock</title><h1>It is ${time} in ${timeZone}.</h1>`)
}).listen(3000, () => console.log("Listening on http://localhost:3000"))
