const express = require("express");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "dashboard", "out");
const port = Number(process.env.DASHBOARD_PORT || 3001);
const apiTarget =
  process.env.DASHBOARD_API_ORIGIN ||
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.API_URL ||
  "http://localhost:3004/api";
const apiOrigin = apiTarget.replace(/\/api\/?$/, "").replace(/\/+$/, "");

function resolveStaticPath(requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const candidates = [];

  if (decodedPath === "/") {
    candidates.push(path.join(outDir, "index.html"));
  } else {
    const safePath = decodedPath.replace(/^\/+/, "");
    candidates.push(path.join(outDir, safePath));
    candidates.push(path.join(outDir, `${safePath}.html`));
    candidates.push(path.join(outDir, safePath, "index.html"));
  }

  for (const candidate of candidates) {
    if (candidate.startsWith(outDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return Buffer.concat(chunks);
}

const app = express();

app.disable("x-powered-by");
app.use(express.static(outDir, { index: false, extensions: ["html"] }));

app.use("/api", async (req, res) => {
  try {
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readRequestBody(req);
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (["host", "connection", "content-length"].includes(key.toLowerCase())) continue;

      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }

    const upstream = await fetch(`${apiOrigin}${req.originalUrl}`, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    res.status(upstream.status);

    upstream.headers.forEach((value, key) => {
      if (["transfer-encoding", "content-encoding", "content-length"].includes(key.toLowerCase())) {
        return;
      }
      res.setHeader(key, value);
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error instanceof Error ? error.message : "Proxy error",
    });
  }
});

app.get("*", (req, res) => {
  const filePath = resolveStaticPath(req.path);
  if (filePath) {
    return res.sendFile(filePath);
  }

  return res.status(404).send("Not found");
});

app.listen(port, () => {
  console.log(`Dashboard static server listening on http://localhost:${port}`);
  console.log(`Proxying API traffic to ${apiOrigin}`);
});
