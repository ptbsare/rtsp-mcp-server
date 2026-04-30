#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execFile } from "node:child_process";
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import sharp from "sharp";

// ── Environment config ──────────────────────────────────────────────

const RTSP_MAX_RETRIES = (() => {
  const v = parseInt(process.env.RTSP_MAX_RETRIES ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 3;
})();

const RTSP_RETRY_BASE_DELAY_MS = (() => {
  const v = parseInt(process.env.RTSP_RETRY_BASE_DELAY_MS ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 1000;
})();

// ── ffmpeg discovery & auto-download ─────────────────────────────────

const BUILDS_BASE = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";

type FfmpegBuildKey = `${typeof process.platform extends infer P ? string : string}-${typeof process.arch extends infer A ? string : string}`;

interface FfmpegBuild {
  asset: string;       // filename in the release
  extractPath: string; // path inside the archive to the ffmpeg binary
  isZip: boolean;      // true = zip (windows), false = tar.xz (linux)
}

function resolveBuild(): FfmpegBuild | null {
  const p = process.platform;  // "linux" | "win32" | "darwin"
  const a = process.arch;      // "x64" | "arm64" | ...

  if (p === "linux" && a === "x64") {
    return { asset: "ffmpeg-master-latest-linux64-gpl.tar.xz", extractPath: "ffmpeg-master-latest-linux64-gpl/bin/ffmpeg", isZip: false };
  }
  if (p === "linux" && a === "arm64") {
    return { asset: "ffmpeg-master-latest-linuxarm64-gpl.tar.xz", extractPath: "ffmpeg-master-latest-linuxarm64-gpl/bin/ffmpeg", isZip: false };
  }
  if (p === "win32" && a === "x64") {
    return { asset: "ffmpeg-master-latest-win64-gpl.zip", extractPath: "ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe", isZip: true };
  }
  if (p === "win32" && a === "arm64") {
    return { asset: "ffmpeg-master-latest-winarm64-gpl.zip", extractPath: "ffmpeg-master-latest-winarm64-gpl/bin/ffmpeg.exe", isZip: true };
  }
  // macOS — no builds on BtbN, use brew or manual install
  return null;
}

const FFMPEG_CACHE_DIR = join(homedir(), ".rtsp-mcp-server", "bin");
const FFMPEG_CACHED_NAME = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const FFMPEG_CACHED_PATH = join(FFMPEG_CACHE_DIR, FFMPEG_CACHED_NAME);

/** Cached absolute path to the ffmpeg binary (resolved once at startup). */
let ffmpegPath = "ffmpeg";

/** Check if `ffmpeg` exists in PATH. */
function ffmpegExists(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Compute SHA256 hex digest of a file. */
async function sha256File(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Download and verify SHA256 from checksums.sha256 asset. */
async function verifyChecksum(filePath: string, expectedAsset: string): Promise<void> {
  console.error("Verifying SHA256 checksum...");
  const checksumsUrl = `${BUILDS_BASE}/checksums.sha256`;
  const res = await fetch(checksumsUrl);
  if (!res.ok) throw new Error(`Failed to fetch checksums: HTTP ${res.status}`);
  const text = await res.text();

  // Find the matching line: "hash  filename"
  const lines = text.split("\n");
  let expectedHash = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith(expectedAsset)) {
      expectedHash = trimmed.split(/\s+/)[0];
      break;
    }
  }
  if (!expectedHash) {
    console.error(`Warning: checksum entry not found for ${expectedAsset}, skipping verification`);
    return;
  }

  const actualHash = await sha256File(filePath);
  if (actualHash !== expectedHash) {
    throw new Error(`SHA256 mismatch for ${expectedAsset}:\n  expected: ${expectedHash}\n  actual:   ${actualHash}`);
  }
  console.error(`SHA256 verified: ${actualHash}`);
}

/** Download ffmpeg-static from BtbN, verify checksum, extract the binary, cache it. */
async function downloadFfmpeg(build: FfmpegBuild): Promise<string> {
  const url = `${BUILDS_BASE}/${build.asset}`;
  console.error(`Downloading ffmpeg from ${url} ...`);
  mkdirSync(FFMPEG_CACHE_DIR, { recursive: true });

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ffmpeg: HTTP ${res.status}`);
  }

  // Save to temp file for SHA256 verification, then extract
  const { createWriteStream } = await import("node:fs");
  const tmpPath = join(FFMPEG_CACHE_DIR, build.asset);

  // Download to temp file
  const nodeStream = Readable.fromWeb(res.body as any);
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(tmpPath);
    nodeStream.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
    nodeStream.on("error", reject);
  });

  await verifyChecksum(tmpPath, build.asset);

  // Extract the ffmpeg binary from the archive
  const binDir = FFMPEG_CACHE_DIR;
  if (build.isZip) {
    // Windows zip — use unzip or PowerShell
    const { promisify } = await import("node:util");
    const execP = promisify(execFile);
    try {
      await execP("unzip", ["-o", "-j", tmpPath, build.extractPath, "-d", binDir]);
    } catch {
      // Fallback to PowerShell if unzip not available (typical on Windows)
      const psCmd = `Expand-Archive -Path '${tmpPath}' -DestinationPath '${binDir}' -Force; ` +
        `Move-Item -Path '${join(binDir, build.extractPath)}' -Destination '${FFMPEG_CACHED_PATH}' -Force`;
      await execP("powershell", ["-Command", psCmd]);
    }
  } else {
    // Linux/macOS tar.xz
    const dirName = build.extractPath.split("/")[0];
    const tarProc = spawn(
      "tar",
      ["-xJf", tmpPath, "--strip-components=2", "-C", binDir, build.extractPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    tarProc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    await new Promise<void>((resolve, reject) => {
      tarProc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exited with code ${code}: ${stderr.slice(-300)}`));
      });
      tarProc.on("error", reject);
    });
  }

  // Clean up temp archive
  const { unlinkSync } = await import("node:fs");
  try { unlinkSync(tmpPath); } catch { /* ignore */ }

  chmodSync(FFMPEG_CACHED_PATH, 0o755);
  console.error(`ffmpeg cached at ${FFMPEG_CACHED_PATH}`);
  return FFMPEG_CACHED_PATH;
}

/**
 * Ensure an ffmpeg binary is available.
 *  1. Check PATH for system ffmpeg.
 *  2. Check the local cache (~/.rtsp-mcp-server/bin/ffmpeg).
 *  3. Auto-download from BtbN (linux x64/arm64, windows x64/arm64) with SHA256 verification.
 *  4. Otherwise throw with install instructions.
 */
async function ensureFfmpeg(): Promise<string> {
  // 1. System ffmpeg
  if (await ffmpegExists()) {
    console.error("Using system ffmpeg");
    return "ffmpeg";
  }

  // 2. Cached binary from a previous download
  if (existsSync(FFMPEG_CACHED_PATH)) {
    console.error(`Using cached ffmpeg at ${FFMPEG_CACHED_PATH}`);
    return FFMPEG_CACHED_PATH;
  }

  // 3. Auto-download
  const build = resolveBuild();
  if (build) {
    try {
      return await downloadFfmpeg(build);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ffmpeg not found and auto-download failed: ${msg}\n` +
          "Please install ffmpeg manually: https://ffmpeg.org/download.html",
      );
    }
  }

  // 4. macOS or unsupported platform
  throw new Error(
    "ffmpeg not found in PATH. Please install it:\n" +
      "  macOS:       brew install ffmpeg\n" +
      "  Ubuntu:      sudo apt install ffmpeg\n" +
      "  Arch Linux:  sudo pacman -S ffmpeg\n" +
      "  Windows:     https://github.com/BtbN/FFmpeg-Builds/releases\n" +
      "  Or place a static ffmpeg binary at: " + FFMPEG_CACHED_PATH,
  );
}

// ── Source parsing ───────────────────────────────────────────────────

interface RtspSource {
  name: string;
  url: string;
}

/**
 * Parse RTSP_URLS environment variable.
 *
 * Entries are separated by semicolons (;) or commas (,).
 * Each entry can be:
 *   name=url   — named source (e.g. kitchen=rtsp://host/stream?user=a&pwd=b)
 *   url        — auto-named from URL path
 *
 * The parser uses the FIRST "=" to split name from url, so query-string
 * parameters like &user=X&pwd=Y inside the URL are preserved intact.
 *
 * Examples:
 *   RTSP_URLS="cam1=rtsp://host/a;cam2=rtsp://host/b"
 *   RTSP_URLS="rtsp://admin:pass@host/stream?token=abc"
 *   RTSP_URLS="厨房=rtsp://host/a?user=admin&pwd=secret,客厅=rtsp://host/b"
 */
function parseRtspUrls(envValue: string | undefined): RtspSource[] {
  if (!envValue || envValue.trim() === "") return [];

  return envValue
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry, idx) => {
      // Look for the first "="
      const eqIdx = entry.indexOf("=");
      if (eqIdx > 0) {
        const beforeEq = entry.substring(0, eqIdx);
        // If the part before "=" contains "://", this is a bare URL like
        // rtsp://host/path?query=value — NOT a name=url pair.
        if (!beforeEq.includes("://")) {
          const name = beforeEq.trim();
          const url = entry.substring(eqIdx + 1).trim();
          return { name, url };
        }
      }
      // Bare URL — auto-generate a name from the URL path
      try {
        const u = new URL(entry);
        const pathPart = u.pathname.replace(/\//g, "_").replace(/^_/, "");
        const name = pathPart || `source_${idx}`;
        return { name, url: entry };
      } catch {
        return { name: `source_${idx}`, url: entry };
      }
    });
}

// ── ffmpeg frame capture ─────────────────────────────────────────────

/**
 * Single attempt: grab one JPEG frame from an RTSP URL via ffmpeg.
 */
function grabFrameOnce(url: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-rtsp_transport", "tcp",
      "-i", url,
      "-frames:v", "1",
      "-f", "image2",
      "-c:v", "mjpeg",
      "pipe:1",
    ];

    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderrData = "";

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        return reject(
          new Error(`ffmpeg exited with code ${code}: ${stderrData.slice(-300)}`),
        );
      }
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) {
        return reject(new Error("ffmpeg produced no output frame"));
      }
      resolve(raw);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Grab a frame with exponential-backoff retry.
 *
 * Attempt 0 runs immediately. On each subsequent attempt the wait is:
 *   baseDelay × 2^(attempt-1)
 *
 * Defaults: 3 retries (4 total attempts), 1 s base delay.
 * Configurable via RTSP_MAX_RETRIES / RTSP_RETRY_BASE_DELAY_MS.
 */
async function grabFrameWithRetry(
  url: string,
  timeoutMs: number,
  maxRetries = RTSP_MAX_RETRIES,
  baseDelay = RTSP_RETRY_BASE_DELAY_MS,
): Promise<{ frame: Buffer; attempt: number }> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = baseDelay * Math.pow(2, attempt - 1);
      console.error(`[retry ${attempt}/${maxRetries}] waiting ${backoff}ms...`);
      await sleep(backoff);
    }

    try {
      const frame = await grabFrameOnce(url, timeoutMs);
      return { frame, attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[attempt ${attempt + 1}/${maxRetries + 1}] ${lastError.message}`);
    }
  }

  throw lastError ?? new Error("grabFrame failed");
}

// ── Image format conversion ─────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

async function convertFrame(
  jpegBuf: Buffer,
  format: "jpeg" | "png" | "webp",
): Promise<Buffer> {
  if (format === "jpeg") return jpegBuf;
  try {
    return await sharp(jpegBuf).toFormat(format, { quality: 85 }).toBuffer();
  } catch {
    return jpegBuf;
  }
}

// ── Build source list from environment ───────────────────────────────

const sources = parseRtspUrls(process.env.RTSP_URLS);

// ── MCP server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: "rtsp-mcp-server",
  version: "0.1.0",
});

// ── Tool: get_frame ──────────────────────────────────────────────────

// Build description dynamically so list_tools already carries source info
function buildGetFrameDescription(): string {
  const lines: string[] = [
    "Capture a single frame from an RTSP camera stream and return it as an image.",
  ];

  if (sources.length === 0) {
    lines.push(
      "No sources pre-configured. You must provide a full RTSP 'url' parameter.",
    );
  } else if (sources.length === 1) {
    lines.push(
      `1 source configured: "${sources[0].name}". ` +
        `The 'server' parameter defaults to "${sources[0].name}" if omitted.`,
    );
  } else {
    lines.push(
      `${sources.length} sources configured — pass the 'server' name or a direct 'url':`,
    );
    for (const s of sources) {
      const masked = s.url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
      lines.push(`  • ${s.name} — ${masked}`);
    }
  }

  lines.push(
    `Automatically retries on failure (up to ${RTSP_MAX_RETRIES} retries, ` +
      `exponential backoff base ${RTSP_RETRY_BASE_DELAY_MS}ms).`,
  );

  return lines.join("\n");
}

// Build server parameter description with available names inline
function buildServerParamDesc(): string {
  if (sources.length === 1) {
    return `RTSP source name. Defaults to "${sources[0].name}" if omitted.`;
  }
  if (sources.length > 1) {
    return (
      `RTSP source name. Available: ${sources.map((s) => `"${s.name}"`).join(", ")}. ` +
      `Pass the exact name from this list.`
    );
  }
  return "RTSP source name (none configured via RTSP_URLS).";
}

server.tool(
  "get_frame",
  buildGetFrameDescription(),
  {
    server: z
      .string()
      .optional()
      .describe(buildServerParamDesc()),
    url: z
      .string()
      .optional()
      .describe(
        "Direct RTSP URL to capture from (may include embedded credentials and query parameters). " +
          "Overrides 'server' if both are provided.",
      ),
    format: z
      .enum(["jpeg", "png", "webp"])
      .default("jpeg")
      .describe("Image output format (default: jpeg)"),
    timeout: z
      .number()
      .int()
      .min(1000)
      .max(60000)
      .default(10000)
      .describe("Per-attempt capture timeout in milliseconds (1000–60000, default: 10000)"),
  },
  async ({ server: serverName, url, format, timeout }) => {
    let targetUrl = url;

    if (!targetUrl) {
      if (!serverName && sources.length === 1) {
        targetUrl = sources[0].url;
      } else if (!serverName) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                sources.length > 0
                  ? `Please specify a 'server' name (${sources.map((s) => `"${s.name}"`).join(", ")}) or a direct 'url'.`
                  : "No RTSP sources are configured in RTSP_URLS. Please provide a 'url' parameter directly.",
            },
          ],
          isError: true,
        };
      } else {
        const source = sources.find(
          (s) => s.name.toLowerCase() === serverName.toLowerCase(),
        );
        if (!source) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown server "${serverName}". Available: ${sources.map((s) => s.name).join(", ")}.`,
              },
            ],
            isError: true,
          };
        }
        targetUrl = source.url;
      }
    }

    try {
      const { frame: jpegFrame, attempt } = await grabFrameWithRetry(
        targetUrl,
        timeout ?? 10000,
      );

      const outFormat = (format ?? "jpeg") as "jpeg" | "png" | "webp";
      const frame = await convertFrame(jpegFrame, outFormat);
      const mime = MIME_MAP[outFormat] ?? "image/jpeg";

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      if (attempt > 0) {
        content.push({
          type: "text" as const,
          text: `Captured after ${attempt + 1} attempts (${attempt} ${attempt === 1 ? "retry" : "retries"}).`,
        });
      }

      content.push({
        type: "image" as const,
        data: frame.toString("base64"),
        mimeType: mime,
      });

      return { content };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to capture frame after ${RTSP_MAX_RETRIES + 1} attempts: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ── Tool: get_frames ─────────────────────────────────────────────────

function buildGetFramesDescription(): string {
  const lines: string[] = [
    "Capture multiple consecutive frames from an RTSP camera stream and return them as images.",
  ];

  if (sources.length === 0) {
    lines.push("No sources pre-configured. You must provide a full RTSP 'url' parameter.");
  } else if (sources.length === 1) {
    lines.push(
      `1 source configured: "${sources[0].name}". ` +
        `The 'server' parameter defaults to "${sources[0].name}" if omitted.`,
    );
  } else {
    lines.push(`${sources.length} sources configured — pass the 'server' name or a direct 'url':`);
    for (const s of sources) {
      const masked = s.url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
      lines.push(`  • ${s.name} — ${masked}`);
    }
  }

  lines.push(`Automatically retries on failure (up to ${RTSP_MAX_RETRIES} retries, exponential backoff base ${RTSP_RETRY_BASE_DELAY_MS}ms).`);

  return lines.join("\n");
}

/** Grab N consecutive JPEG frames from an RTSP URL at the given fps. */
function grabFramesOnce(
  url: string,
  count: number,
  fps: number,
  timeoutMs: number,
): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const args = [
      "-rtsp_transport", "tcp",
      "-i", url,
      "-an",
      "-vf", `fps=${fps}`,
      "-frames:v", String(count),
      "-c:v", "mjpeg",
      "-q:v", "2",
      "-f", "image2pipe",
      "pipe:1",
    ];

    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderrData = "";

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (d: Buffer) => { stderrData += d.toString(); });

    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        return reject(new Error(`ffmpeg exited with code ${code}: ${stderrData.slice(-300)}`));
      }

      const all = Buffer.concat(chunks);
      if (all.length === 0) return reject(new Error("ffmpeg produced no output"));

      // Split the concatenated JPEG stream into individual frames.
      // JPEG files start with FF D8 and end with FF D9.
      const frames: Buffer[] = [];
      let start = -1;
      for (let i = 0; i < all.length - 1; i++) {
        if (all[i] === 0xff && all[i + 1] === 0xd8) {
          start = i;
        }
        if (start >= 0 && all[i] === 0xff && all[i + 1] === 0xd9) {
          frames.push(all.subarray(start, i + 2));
          start = -1;
        }
      }

      if (frames.length === 0) return reject(new Error("No JPEG frames found in ffmpeg output"));
      resolve(frames);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}

async function grabFramesWithRetry(
  url: string,
  count: number,
  fps: number,
  timeoutMs: number,
): Promise<{ frames: Buffer[]; attempt: number }> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= RTSP_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = RTSP_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.error(`[retry ${attempt}/${RTSP_MAX_RETRIES}] waiting ${backoff}ms...`);
      await sleep(backoff);
    }
    try {
      const frames = await grabFramesOnce(url, count, fps, timeoutMs);
      return { frames, attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[attempt ${attempt + 1}/${RTSP_MAX_RETRIES + 1}] ${lastError.message}`);
    }
  }
  throw lastError ?? new Error("grabFrames failed");
}

server.tool(
  "get_frames",
  buildGetFramesDescription(),
  {
    server: z
      .string()
      .optional()
      .describe(buildServerParamDesc()),
    url: z
      .string()
      .optional()
      .describe(
        "Direct RTSP URL to capture from (may include embedded credentials and query parameters). " +
          "Overrides 'server' if both are provided.",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(7)
      .describe("Number of consecutive frames to capture (1–30, default: 7)"),
    fps: z
      .number()
      .min(0.1)
      .max(10)
      .default(1)
      .describe("Frames per second to capture (0.1–10, default: 1). Combined with count, determines total capture duration."),
    format: z
      .enum(["jpeg", "png", "webp"])
      .default("jpeg")
      .describe("Image output format (default: jpeg)"),
    timeout: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .default(30000)
      .describe("Total capture timeout in milliseconds (1000–120000, default: 30000). Should exceed count/fps duration."),
  },
  async ({ server: serverName, url, count, fps, format, timeout }) => {
    let targetUrl = url;

    if (!targetUrl) {
      if (!serverName && sources.length === 1) {
        targetUrl = sources[0].url;
      } else if (!serverName) {
        return {
          content: [
            {
              type: "text" as const,
              text: sources.length > 0
                ? `Please specify a 'server' name (${sources.map((s) => `"${s.name}"`).join(", ")}) or a direct 'url'.`
                : "No RTSP sources are configured in RTSP_URLS. Please provide a 'url' parameter directly.",
            },
          ],
          isError: true,
        };
      } else {
        const source = sources.find((s) => s.name.toLowerCase() === serverName.toLowerCase());
        if (!source) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown server "${serverName}". Available: ${sources.map((s) => s.name).join(", ")}.`,
              },
            ],
            isError: true,
          };
        }
        targetUrl = source.url;
      }
    }

    const frameCount = count ?? 7;
    const frameFps = fps ?? 1;
    const frameTimeout = timeout ?? 30000;
    const outFormat = (format ?? "jpeg") as "jpeg" | "png" | "webp";
    const mime = MIME_MAP[outFormat] ?? "image/jpeg";

    try {
      const { frames: jpegFrames, attempt } = await grabFramesWithRetry(
        targetUrl, frameCount, frameFps, frameTimeout,
      );

      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [];

      if (attempt > 0) {
        content.push({
          type: "text" as const,
          text: `Captured after ${attempt + 1} attempts (${attempt} ${attempt === 1 ? "retry" : "retries"}).`,
        });
      }

      const duration = (frameCount / frameFps).toFixed(1);
      content.push({
        type: "text" as const,
        text: `Captured ${jpegFrames.length} frame(s) at ${frameFps} fps over ~${duration}s.`,
      });

      for (let i = 0; i < jpegFrames.length; i++) {
        const frame = await convertFrame(jpegFrames[i], outFormat);
        content.push({
          type: "image" as const,
          data: frame.toString("base64"),
          mimeType: mime,
        });
      }

      return { content };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to capture frames after ${RTSP_MAX_RETRIES + 1} attempts: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ── Resource: rtsp://sources ────────────────────────────────────────

server.resource("rtsp-sources", "rtsp://sources", async (uri) => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(
        sources.map((s) => ({
          name: s.name,
          url: s.url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@"),
        })),
        null,
        2,
      ),
    },
  ],
}));

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // Ensure ffmpeg is available before accepting requests
  ffmpegPath = await ensureFfmpeg();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("rtsp-mcp-server started (stdio transport)");
  console.error(`Retry config: max=${RTSP_MAX_RETRIES}, base_delay=${RTSP_RETRY_BASE_DELAY_MS}ms`);
  console.error(`ffmpeg path: ${ffmpegPath}`);
  if (sources.length > 0) {
    console.error(`Configured RTSP sources: ${sources.map((s) => s.name).join(", ")}`);
  } else {
    console.error("No RTSP sources configured. Use RTSP_URLS env var or provide URLs directly via the 'url' parameter.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
