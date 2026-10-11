import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const root = resolve(".");
const config = JSON.parse(await readFile("vercel.json", "utf8"));
const headers = Object.fromEntries(config.headers.find((rule) => rule.source === "/(.*)").headers.map(({ key, value }) => [key, value]));
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const path = resolve(root, "." + (pathname === "/" ? "/home.html" : pathname));
    if (!path.startsWith(root + sep) || pathname.split("/").some((part) => part.startsWith("."))) throw new Error("Forbidden path");
    if (!(await stat(path)).isFile()) throw new Error("Not a file");
    const data = await readFile(path);
    response.writeHead(200, { ...headers, "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(Number(process.env.PORT || 4176), "127.0.0.1", () => console.log("Ultra Fischer: http://127.0.0.1:" + (process.env.PORT || 4176)));
