import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./api/review.js";

const root = fileURLToPath(new URL(".", import.meta.url));

function loadEnv() {
  const path = resolve(root, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (url.pathname === "/api/review") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (data) => {
      if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
      return res;
    };

    try {
      await handler(req, res);
    } catch (error) {
      if (!res.writableEnded) sendJson(res, 500, { error: error.message || "Server error" });
    }
    return;
  }

  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(root, relative);
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || !existsSync(file)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  res.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.end(readFileSync(file));
});

let port = Number(process.env.PORT) || 3000;

function wifiUrls(listenPort) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${listenPort}`);
    }
  }
  return urls;
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && !process.env.PORT && port < 3020) {
    port += 1;
    server.listen(port, "0.0.0.0");
    return;
  }
  console.error(error.message);
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  const ready = process.env.GEMINI_API_KEY ? "Gemini key loaded" : "GEMINI_API_KEY missing";
  console.log(`On this Mac http://127.0.0.1:${port} (${ready})`);
  for (const url of wifiUrls(port)) console.log(`On Wi-Fi ${url}`);
});
