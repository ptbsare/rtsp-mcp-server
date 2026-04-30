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

const FFMPEG_DOWNLOAD_URL =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";

const FFMPEG_CACHE_DIR = join(homedir(), ".rtsp-mcp-server", "bin");
const FFMPEG_CACHED_PATH = join(FFMPEG_CACHE_DIR, "ffmpeg");

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

/** Download ffmpeg-static from BtbN, extract the binary, cache it. */
async function downloadFfmpeg(): Promise<string> {
  console.error(`Downloading ffmpeg from ${FFMPEG_DOWNLOAD_URL} ...`);
  mkdirSync(FFMPEG_CACHE_DIR, { recursive: true });

  const res = await fetch(FFMPEG_DOWNLOAD_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ffmpeg: HTTP ${res.status}`);
  }

  // Use tar to stream-decompress and extract only the ffmpeg binary.
  // The tarball layout is: ffmpeg-master-latest-linux64-gpl/bin/ffmpeg
  const tarProc = spawn(
    "tar",
    ["-xJf", "-", "--strip-components=2", "-C", FFMPEG_CACHE_DIR, "ffmpeg-master-latest-linux64-gpl/bin/ffmpeg"],
    { stdio: ["pipe", "ignore", "pipe"] },
  );

  const nodeStream = Readable.fromWeb(res.body as any);
  nodeStream.pipe(tarProc.stdin);

  let stderr = "";
  tarProc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

  await new Promise<void>((resolve, reject) => {
    tarProc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}: ${stderr.slice(-300)}`));
    });
    tarProc.on("error", reject);
  });

  chmodSync(FFMPEG_CACHED_PATH, 0o755);
  console.error(`ffmpeg cached at ${FFMPEG_CACHED_PATH}`);
  return FFMPEG_CACHED_PATH;
}

/**
 * Ensure an ffmpeg binary is available.
 *  1. Check PATH for system ffmpeg.
 *  2. Check the local cache (~/.rtsp-mcp-server/bin/ffmpeg).
 *  3. If on linux x64, auto-download from BtbN.
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

  // 3. Auto-download on linux x64
  if (process.platform === "linux" && process.arch === "x64") {
    try {
      return await downloadFfmpeg();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ffmpeg not found and auto-download failed: ${msg}\n` +
          "Please install ffmpeg manually: https://ffmpeg.org/download.html",
      );
    }
  }

  // 4. Unsupported platform for auto-download
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
