// Tiny static server for docs/ — no dependencies, deterministic, CI-safe.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DOCS = path.join(__dirname, "..", "..", "docs");
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain",
};

function start(port = 0) {
  const srv = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = path.normalize(path.join(DOCS, url === "/" ? "index.html" : url));
    if (!file.startsWith(DOCS)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(buf);
    });
  });
  return new Promise(resolve => srv.listen(port, "127.0.0.1", () => resolve({ srv, port: srv.address().port })));
}

module.exports = { start };
