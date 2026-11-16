#!/usr/bin/env node
/**
 * MCP stdio adapter for HiderTHBROWser's authenticated loopback API.
 * The desktop owns the browser engine; this adapter forwards newline-delimited
 * JSON-RPC messages and never opens a network listener.
 */
import readline from "node:readline";

const TOKEN = process.env.HIDER_API_TOKEN;
const BASE_URL = process.env.HIDER_API_URL || "http://127.0.0.1:10108";

function fail(message, code = 1) {
  process.stderr.write(`HiderTHBROWser MCP: ${message}\n`);
  process.exit(code);
}

if (!TOKEN || TOKEN.trim().length < 16) {
  fail("Set HIDER_API_TOKEN to the local API bearer token shown in the app's API settings.");
}

let base;
try {
  base = new URL(BASE_URL);
} catch {
  fail("HIDER_API_URL must be a valid loopback URL, e.g. http://127.0.0.1:10108.");
}

if (
  base.protocol !== "http:" ||
  base.hostname !== "127.0.0.1" ||
  base.username ||
  base.password ||
  base.search ||
  base.hash
) {
  fail("For safety, the local MCP adapter only connects to http://127.0.0.1.");
}

const endpoint = new URL("/v1/mcp", base);
let sessionId = null;
let queue = Promise.resolve();

function writeMessage(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function forward(line) {
  if (!line.trim()) return;
  if (Buffer.byteLength(line, "utf8") > 2 * 1024 * 1024) {
    writeMessage(errorResponse(null, -32700, "MCP message exceeds the 2 MiB local API limit."));
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage(errorResponse(null, -32700, "Invalid JSON on MCP stdin."));
    return;
  }

  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  if (sessionId) headers["MCP-Session-Id"] = sessionId;

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
  } catch (error) {
    writeMessage(errorResponse(
      message.id,
      -32000,
      `Could not reach the local Hider API at ${endpoint.origin}. Open HiderTHBROWser and check its API settings. ${error.message}`
    ));
    return;
  }

  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) sessionId = nextSession;

  if (response.status === 202) return;

  const text = await response.text();
  if (!response.ok) {
    if (response.status === 404) sessionId = null;
    writeMessage(errorResponse(
      message.id,
      response.status === 429 ? -32005 : -32000,
      `Local MCP HTTP ${response.status}: ${text.trim() || response.statusText || "Request failed"}`
    ));
    return;
  }

  try {
    writeMessage(JSON.parse(text));
  } catch {
    writeMessage(errorResponse(message.id, -32603, "The local MCP endpoint returned invalid JSON."));
  }
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false
});

input.on("line", (line) => {
  queue = queue.then(() => forward(line)).catch((error) => {
    process.stderr.write(`HiderTHBROWser MCP adapter error: ${error.message}\n`);
  });
});

input.on("close", async () => {
  await queue;
  process.exit(0);
});
