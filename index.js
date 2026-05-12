#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { stat, lstat, unlink, readdir } from "node:fs/promises";
import path, { join } from "node:path";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Detect whether this file is being run directly (CLI) or imported (tests).
// When imported, we skip the fatal env-var check and the transport startup so
// pure helpers (validateSourcePath, AdbLock, parseUiAutomatorXml) can be
// unit-tested in isolation.
import { fileURLToPath, pathToFileURL } from "node:url";

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
const IS_MAIN_MODULE = isMainModule();

const ADB_HOST = process.env.ADB_HOST || process.env.BOOX_ADB_HOST;
const ADB_PORT = process.env.ADB_PORT || process.env.BOOX_ADB_PORT || "5555";

if (IS_MAIN_MODULE && !ADB_HOST) {
  console.error("ADB_HOST environment variable is required");
  process.exit(1);
}

const DEVICE_SERIAL = ADB_HOST ? `${ADB_HOST}:${ADB_PORT}` : "";
const ADB_BIN = process.env.ADB_BIN || "adb";

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB
const SCREENCAP_MIN_INTERVAL_MS = 10_000;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Allowlist configuration
// ---------------------------------------------------------------------------

function parseAllowlist(envValue, defaults) {
  if (!envValue) return defaults;
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveAllowlist(prefixes) {
  // Resolve once at startup so all subsequent comparisons are normalized.
  return prefixes.map((p) => path.resolve(p));
}

const ALLOWED_PUSH_PREFIXES = resolveAllowlist(
  parseAllowlist(process.env.MCP_ALLOWED_PUSH_DIRS, ["/tmp/"])
);
const ALLOWED_INSTALL_PREFIXES = resolveAllowlist(
  parseAllowlist(process.env.MCP_ALLOWED_INSTALL_DIRS, ["/tmp/"])
);

// ---------------------------------------------------------------------------
// Serialization lock
// ---------------------------------------------------------------------------

export class AdbLock {
  constructor() {
    this._queue = Promise.resolve();
  }

  acquire(fn) {
    const task = this._queue.then(
      () => fn(),
      () => fn()
    );
    // Keep the queue moving regardless of success/failure
    this._queue = task.catch(() => {});
    return task;
  }
}

const lock = new AdbLock();

// ---------------------------------------------------------------------------
// Screencap rate limiter
// ---------------------------------------------------------------------------

let lastScreencapTime = 0;

// ---------------------------------------------------------------------------
// Temp file cleanup
// ---------------------------------------------------------------------------

async function cleanupTempFiles() {
  try {
    const files = await readdir("/tmp");
    const now = Date.now();
    const prefixes = ["adb-mcp-screencap-", "adb-mcp-pull-", "adb-mcp-uidump-"];
    for (const file of files) {
      if (!prefixes.some((p) => file.startsWith(p))) continue;
      const filePath = join("/tmp", file);
      try {
        const st = await stat(filePath);
        if (now - st.mtimeMs > TEMP_MAX_AGE_MS) {
          await unlink(filePath);
        }
      } catch {
        // File may have been removed already
      }
    }
  } catch {
    // /tmp read failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// ADB command helpers
// ---------------------------------------------------------------------------

function truncate(str, maxBytes) {
  if (Buffer.byteLength(str) <= maxBytes) return str;
  const buf = Buffer.from(str);
  const truncated = buf.subarray(0, maxBytes).toString("utf8");
  return truncated + `\n... [truncated at ${maxBytes} bytes]`;
}

function adb(...args) {
  return new Promise((resolve, reject) => {
    const fullArgs = ["-s", DEVICE_SERIAL, ...args];
    const timeout =
      args.includes("install") || args.includes("push") || args.includes("pull")
        ? LONG_TIMEOUT_MS
        : DEFAULT_TIMEOUT_MS;

    execFile(ADB_BIN, fullArgs, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(new Error(`Command timed out after ${timeout / 1000}s`));
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: err ? err.code || 1 : 0 });
    });
  });
}

function adbRaw(...args) {
  // Returns raw buffer stdout (for screencap)
  return new Promise((resolve, reject) => {
    const fullArgs = ["-s", DEVICE_SERIAL, ...args];
    execFile(
      ADB_BIN,
      fullArgs,
      { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(new Error(`Command timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`));
          return;
        }
        if (err && (!stdout || stdout.length === 0)) {
          reject(new Error(stderr ? stderr.toString() : err.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

async function getDeviceState() {
  try {
    const { stdout } = await adb("get-state");
    return stdout.trim();
  } catch {
    return "error";
  }
}

async function ensureConnected() {
  const state = await getDeviceState();

  if (state === "device") return;

  if (state === "unauthorized") {
    throw new Error(
      "ADB authorization revoked. Physical access to the device required to re-approve."
    );
  }

  // Attempt reconnect
  try {
    await adb("connect", DEVICE_SERIAL);
  } catch {
    // connect may fail, check state again
  }

  const retryState = await getDeviceState();
  if (retryState === "device") return;

  if (retryState === "unauthorized") {
    throw new Error(
      "ADB authorization revoked. Physical access to the device required to re-approve."
    );
  }

  // Classify the failure
  const stateMsg = retryState === "offline" ? "offline" : retryState;
  if (stateMsg === "offline") {
    throw new Error(
      "Device offline. Try `adb disconnect` + `adb connect`, or re-enable ADB TCP via USB."
    );
  }

  throw new Error(
    "Device not connected. Check the device's network connection (Wi-Fi, VPN, etc.)."
  );
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate that `filePath` resolves to a location strictly inside one of
 * `allowedPrefixes`. The check is traversal-safe: `..` segments are resolved
 * before the comparison, so inputs like `/tmp/../etc/passwd` are rejected
 * even when the literal string starts with an allowlisted prefix.
 *
 * `allowedPrefixes` MUST already be resolved (callers should pass values
 * returned by `resolveAllowlist`). The check uses `path.relative` and rejects
 * any path that needs `..` to climb out of the prefix.
 *
 * Symlinks: an `lstat` check rejects symlink leaves. We do NOT walk parent
 * dirs to detect symlinked ancestors — that race is documented as a known
 * limitation. Deploy with a non-root user and a clean staging dir to mitigate.
 */
export function validateSourcePath(filePath, allowedPrefixes, label) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error(`${label} path is required`);
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${label} path must be absolute`);
  }

  const resolvedInput = path.resolve(filePath);

  const insideAllowed = allowedPrefixes.some((prefix) => {
    const rel = path.relative(prefix, resolvedInput);
    if (rel === "") return false; // exact prefix dir itself is not a valid file
    // Reject if rel starts with ".." or is absolute (different root).
    if (rel.startsWith("..")) return false;
    if (path.isAbsolute(rel)) return false;
    return true;
  });

  if (!insideAllowed) {
    throw new Error(
      `${label} path must be under one of: ${allowedPrefixes.join(", ")}`
    );
  }

  return resolvedInput;
}

async function validateSourcePathWithSymlinkCheck(
  filePath,
  allowedPrefixes,
  label
) {
  const resolved = validateSourcePath(filePath, allowedPrefixes, label);
  try {
    const st = await lstat(resolved);
    if (st.isSymbolicLink()) {
      throw new Error(`${label} path must not be a symbolic link`);
    }
  } catch (err) {
    // If lstat fails because file doesn't exist, defer to caller's stat check.
    if (err && err.code !== "ENOENT") throw err;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// UIAutomator XML parser
// ---------------------------------------------------------------------------

const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

function parseBoundsString(boundsStr) {
  if (typeof boundsStr !== "string") return null;
  const m = boundsStr.match(BOUNDS_RE);
  if (!m) return null;
  const left = parseInt(m[1], 10);
  const top = parseInt(m[2], 10);
  const right = parseInt(m[3], 10);
  const bottom = parseInt(m[4], 10);
  return [left, top, right, bottom];
}

function parseBool(v) {
  if (v === true || v === false) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return false;
}

/**
 * Parse a UIAutomator XML dump into a flat list of element descriptors.
 * Exported for unit testing.
 */
export function parseUiAutomatorXml(xml, { clickableOnly = false, withTextOnly = false } = {}) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseAttributeValue: false,
    allowBooleanAttributes: true,
    isArray: (name) => name === "node",
  });

  const doc = parser.parse(xml);
  const elements = [];

  function walk(node) {
    if (!node || typeof node !== "object") return;
    // The actual UI nodes live under the `node` key. Skip the root `hierarchy`.
    const children = node.node;
    if (Array.isArray(children)) {
      for (const child of children) {
        emit(child);
        walk(child);
      }
    }
  }

  function emit(n) {
    if (!n || typeof n !== "object") return;
    const bounds = parseBoundsString(n.bounds);
    const text = typeof n.text === "string" ? n.text : "";
    const contentDescription =
      typeof n["content-desc"] === "string" ? n["content-desc"] : "";
    const clickable = parseBool(n.clickable);

    if (clickableOnly && !clickable) return;
    if (withTextOnly && !text && !contentDescription) return;

    const center =
      bounds != null
        ? [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)]
        : null;

    elements.push({
      bounds,
      center,
      text,
      contentDescription,
      resourceId: typeof n["resource-id"] === "string" ? n["resource-id"] : "",
      className: typeof n.class === "string" ? n.class : "",
      clickable,
      focusable: parseBool(n.focusable),
      enabled: parseBool(n.enabled),
      selected: parseBool(n.selected),
      checked: parseBool(n.checked),
      scrollable: parseBool(n.scrollable),
    });
  }

  // Top-level: { hierarchy: { node: [...] } } or sometimes { hierarchy: { node: {...} } }.
  if (doc && doc.hierarchy) {
    walk(doc.hierarchy);
  }

  return elements;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolAdbStatus() {
  await cleanupTempFiles();
  const state = await getDeviceState();
  if (state !== "device") {
    return { connected: false, state, device_serial: DEVICE_SERIAL };
  }

  const [model, version, sdk] = await Promise.all([
    adb("shell", "getprop", "ro.product.model").then((r) => r.stdout.trim()),
    adb("shell", "getprop", "ro.build.version.release").then((r) => r.stdout.trim()),
    adb("shell", "getprop", "ro.build.version.sdk").then((r) => r.stdout.trim()),
  ]);

  return {
    connected: true,
    state: "device",
    device_serial: DEVICE_SERIAL,
    model,
    android_version: version,
    sdk_level: sdk,
  };
}

async function toolAdbShell({ command, timeout_ms }) {
  await cleanupTempFiles();
  await ensureConnected();

  if (!command || command.trim() === "") {
    throw new Error("Command must not be empty");
  }

  const timeout = Math.min(timeout_ms || DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    execFile(
      ADB_BIN,
      ["-s", DEVICE_SERIAL, "shell", command],
      { timeout, maxBuffer: 10 * 1024 * 1024, shell: false },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(new Error(`Command timed out after ${timeout / 1000}s`));
          return;
        }
        resolve({
          stdout: truncate(stdout || "", MAX_OUTPUT_BYTES),
          stderr: truncate(stderr || "", MAX_OUTPUT_BYTES),
          exit_code: err ? err.code || 1 : 0,
        });
      }
    );
  });
}

async function toolAdbScreencap() {
  await cleanupTempFiles();
  await ensureConnected();

  const now = Date.now();
  const elapsed = now - lastScreencapTime;
  if (elapsed < SCREENCAP_MIN_INTERVAL_MS) {
    const waitSec = ((SCREENCAP_MIN_INTERVAL_MS - elapsed) / 1000).toFixed(1);
    throw new Error(
      `Screencap rate limited. Wait ${waitSec}s before the next capture.`
    );
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `/tmp/adb-mcp-screencap-${timestamp}.png`;

  // Use exec-out to pipe raw PNG directly
  const pngBuffer = await adbRaw("exec-out", "screencap", "-p");

  const { writeFile } = await import("node:fs/promises");
  await writeFile(outPath, pngBuffer);

  lastScreencapTime = Date.now();

  // Try to get dimensions from the PNG header (IHDR chunk)
  let width = null;
  let height = null;
  if (pngBuffer.length >= 24) {
    width = pngBuffer.readUInt32BE(16);
    height = pngBuffer.readUInt32BE(20);
  }

  return {
    path: outPath,
    format: "png",
    size_bytes: pngBuffer.length,
    width,
    height,
  };
}

async function toolAdbInstall({ apk_path }) {
  await cleanupTempFiles();
  await ensureConnected();

  if (!apk_path || !apk_path.endsWith(".apk")) {
    throw new Error("apk_path must end with .apk");
  }

  const resolvedApkPath = await validateSourcePathWithSymlinkCheck(
    apk_path,
    ALLOWED_INSTALL_PREFIXES,
    "APK"
  );

  // Verify file exists
  try {
    await stat(resolvedApkPath);
  } catch {
    throw new Error(`APK file not found: ${apk_path}`);
  }

  const result = await adb("install", "-r", resolvedApkPath);
  const success =
    result.stdout.includes("Success") || result.stderr.includes("Success");

  return {
    success,
    stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
    stderr: truncate(result.stderr, MAX_OUTPUT_BYTES),
    warning:
      "Reinstalling may reset the accessibility service. Re-enable if needed.",
  };
}

async function toolAdbPush({ local_path, device_path }) {
  await cleanupTempFiles();
  await ensureConnected();

  if (!device_path || !device_path.startsWith("/")) {
    throw new Error("device_path must be an absolute path on the device");
  }

  const resolvedLocalPath = await validateSourcePathWithSymlinkCheck(
    local_path,
    ALLOWED_PUSH_PREFIXES,
    "Source"
  );

  // Verify file exists
  try {
    await stat(resolvedLocalPath);
  } catch {
    throw new Error(`Source file not found: ${local_path}`);
  }

  const result = await adb("push", resolvedLocalPath, device_path);
  const success = result.exitCode === 0;

  return {
    success,
    message: truncate(
      (result.stdout + "\n" + result.stderr).trim(),
      MAX_OUTPUT_BYTES
    ),
  };
}

async function toolAdbPull({ device_path, local_path }) {
  await cleanupTempFiles();
  await ensureConnected();

  if (!device_path || !device_path.startsWith("/")) {
    throw new Error("device_path must be an absolute path on the device");
  }

  // Default local path to /tmp/adb-mcp-pull-*
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = device_path.split("/").pop() || "file";
  const dest = local_path || `/tmp/adb-mcp-pull-${timestamp}-${filename}`;

  const result = await adb("pull", device_path, dest);
  if (result.exitCode !== 0) {
    throw new Error(
      `Pull failed: ${(result.stdout + " " + result.stderr).trim()}`
    );
  }

  let size_bytes = null;
  try {
    const st = await stat(dest);
    size_bytes = st.size;
  } catch {
    // stat failure non-fatal
  }

  return {
    success: true,
    path: dest,
    size_bytes,
    message: truncate(result.stdout.trim(), MAX_OUTPUT_BYTES),
  };
}

async function toolAdbInput({ type, params }) {
  await cleanupTempFiles();
  await ensureConnected();

  let inputArgs;

  switch (type) {
    case "tap": {
      const { x, y } = params;
      if (x == null || y == null)
        throw new Error("tap requires x and y coordinates");
      inputArgs = ["input", "tap", String(Math.round(x)), String(Math.round(y))];
      break;
    }
    case "swipe": {
      const { x1, y1, x2, y2, duration_ms } = params;
      if (x1 == null || y1 == null || x2 == null || y2 == null)
        throw new Error("swipe requires x1, y1, x2, y2");
      inputArgs = [
        "input",
        "swipe",
        String(Math.round(x1)),
        String(Math.round(y1)),
        String(Math.round(x2)),
        String(Math.round(y2)),
      ];
      if (duration_ms != null) inputArgs.push(String(Math.round(duration_ms)));
      break;
    }
    case "keyevent": {
      const { code } = params;
      if (code == null) throw new Error("keyevent requires a code");
      inputArgs = ["input", "keyevent", String(code)];
      break;
    }
    case "text": {
      const { value } = params;
      if (!value) throw new Error("text requires a value");
      // Escape spaces for adb shell input text
      const escaped = value.replace(/ /g, "%s");
      inputArgs = ["input", "text", escaped];
      break;
    }
    default:
      throw new Error(
        `Unknown input type: ${type}. Use tap, swipe, keyevent, or text.`
      );
  }

  const result = await adb("shell", ...inputArgs);
  return {
    success: result.exitCode === 0,
    type,
  };
}

async function toolAdbUiDump({
  clickable_only = false,
  with_text_only = false,
  include_raw_xml = false,
} = {}) {
  await cleanupTempFiles();
  await ensureConnected();

  // Step 1: trigger the dump on the device.
  const dumpResult = await adb(
    "shell",
    "uiautomator",
    "dump",
    "/sdcard/window_dump.xml"
  );
  if (dumpResult.exitCode !== 0) {
    throw new Error(
      `uiautomator dump failed: ${(dumpResult.stdout + " " + dumpResult.stderr).trim()}`
    );
  }

  // Step 2: stream the file back via exec-out (avoids a temp file on the host).
  const xmlBuffer = await adbRaw("exec-out", "cat", "/sdcard/window_dump.xml");
  const xml = xmlBuffer.toString("utf8");

  if (!xml || xml.trim() === "") {
    throw new Error(
      "uiautomator dump produced empty output. The device may be in a state that blocks dumping (e.g. secure window)."
    );
  }

  // Step 3: parse and filter.
  const elements = parseUiAutomatorXml(xml, {
    clickableOnly: clickable_only,
    withTextOnly: with_text_only,
  });

  const out = {
    elements,
    element_count: elements.length,
  };
  if (include_raw_xml) out.raw_xml = xml;
  return out;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "adb_status",
    description:
      "Check if the device is connected via ADB and return device info (model, Android version, SDK level). Also cleans up old temp files.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "adb_shell",
    description:
      "Run a shell command on the device via ADB. Returns stdout, stderr, and exit code. Output is truncated at 100KB.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run on the device",
        },
        timeout_ms: {
          type: "number",
          description: "Command timeout in milliseconds (default 30000, max 120000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "adb_screencap",
    description:
      "Capture the device screen. Saves native PNG to a temp file on the host and returns the file path, dimensions, and size. Rate-limited to 1 capture per 10 seconds.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "adb_install",
    description:
      "Install an APK on the device. Reinstalls are allowed; downgrades are blocked. APK must be located under an allowlisted directory (see MCP_ALLOWED_INSTALL_DIRS, default /tmp/). WARNING: Reinstalling may reset the accessibility service.",
    inputSchema: {
      type: "object",
      properties: {
        apk_path: {
          type: "string",
          description: "Absolute path to the APK file on the host",
        },
      },
      required: ["apk_path"],
    },
  },
  {
    name: "adb_push",
    description:
      "Push a file from the host to the device. Source must be under an allowlisted directory (see MCP_ALLOWED_PUSH_DIRS, default /tmp/).",
    inputSchema: {
      type: "object",
      properties: {
        local_path: {
          type: "string",
          description: "Absolute path to the file on the host",
        },
        device_path: {
          type: "string",
          description: "Absolute destination path on the device",
        },
      },
      required: ["local_path", "device_path"],
    },
  },
  {
    name: "adb_pull",
    description:
      "Pull a file from the device to the host. Returns the local path and file size. Files are saved to /tmp/ by default.",
    inputSchema: {
      type: "object",
      properties: {
        device_path: {
          type: "string",
          description: "Absolute path to the file on the device",
        },
        local_path: {
          type: "string",
          description: "Optional: absolute destination path on the host (defaults to /tmp/)",
        },
      },
      required: ["device_path"],
    },
  },
  {
    name: "adb_input",
    description:
      "Simulate input on the device: tap, swipe, keyevent, or text. Common keycodes: 4=Back, 3=Home, 66=Enter, 26=Power.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["tap", "swipe", "keyevent", "text"],
          description: "Input type",
        },
        params: {
          type: "object",
          description:
            "Parameters for the input type. tap: {x, y}. swipe: {x1, y1, x2, y2, duration_ms?}. keyevent: {code}. text: {value}.",
        },
      },
      required: ["type", "params"],
    },
  },
  {
    name: "adb_ui_dump",
    description:
      "Dump the current UI hierarchy as structured JSON. Each element includes bounds, computed centerpoint (useful for taps), text, content description, resource ID, class, and interactivity flags. Filter to clickable elements with clickable_only=true.",
    inputSchema: {
      type: "object",
      properties: {
        clickable_only: {
          type: "boolean",
          description: "If true, return only elements where clickable=true (default false)",
        },
        with_text_only: {
          type: "boolean",
          description:
            "If true, return only elements with non-empty text or contentDescription (default false)",
        },
        include_raw_xml: {
          type: "boolean",
          description: "If true, also include the raw XML under raw_xml (default false)",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "adb-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await lock.acquire(async () => {
      switch (name) {
        case "adb_status":
          return await toolAdbStatus();
        case "adb_shell":
          return await toolAdbShell(args);
        case "adb_screencap":
          return await toolAdbScreencap();
        case "adb_install":
          return await toolAdbInstall(args);
        case "adb_push":
          return await toolAdbPush(args);
        case "adb_pull":
          return await toolAdbPull(args);
        case "adb_input":
          return await toolAdbInput(args);
        case "adb_ui_dump":
          return await toolAdbUiDump(args || {});
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (IS_MAIN_MODULE) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
