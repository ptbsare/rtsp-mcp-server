#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import sharp from "sharp";

/**
 * Parse RTSP_URLS environment variable.
 * URLs are separated by commas. Each entry can be:
 *   - a plain URL: rtsp://host/path
 *   - a named entry: name=url  (e.g. kitchen=rtsp://user:pass@host/stream)
 *
 * The URL may contain embedded credentials (rtsp://user:pass@host/path).
 */

interface RtspSource {
  name: string;
  url: string;
}

function parseRtspUrls(envValue: string | undefined): RtspSource[] {
  if (!envValue || envValue.trim() === "") return [];

  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry, idx) => {
      const eqIdx = entry.indexOf("=");
      if (eqIdx > 0 && !entry.substring(0, eqIdx).includes("://")) {
        const name = entry.substring(0, eqIdx).trim();
        const url = entry.substring(eqIdx + 1).trim();
        return { name, url };
      }
      // Auto-generate a name from the URL
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

/**
 * Grab a single frame from an RTSP URL using ffmpeg, return raw JPEG/PNG/WebP buffer.
 */
async function grabFrame(
  url: string,
  format: "jpeg" | "png" | "webp" = "jpeg",
  timeoutMs: number = 10000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-rtsp_transport", "tcp",
      "-i", url,
      "-frames:v", "1",
      "-f", "image2",
      "-c:v", "mjpeg",
      "pipe:1",
    ];

    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    const chunks: Buffer[] = [];
    let stderrData = "";

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        return reject(
          new Error(`ffmpeg exited with code ${code}: ${stderrData.slice(-500)}`),
        );
      }

      const raw = Buffer.concat(chunks);
      if (raw.length === 0) {
        return reject(new Error("ffmpeg produced no output frame"));
      }

      // If requested format is jpeg and ffmpeg already output mjpeg, just return as-is
      if (format === "jpeg") {
        return resolve(raw);
      }

      // Convert to requested format via sharp
      try {
        const converted = await sharp(raw)
          .toFormat(format, { quality: 85 })
          .toBuffer();
        resolve(converted);
      } catch (e) {
        // Fall back to raw JPEG if conversion fails
        resolve(raw);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}

// Build source list from environment
const sources = parseRtspUrls(process.env.RTSP_URLS);

// Create MCP server
const server = new McpServer({
  name: "rtsp-mcp-server",
  version: "0.1.0",
});

// Register get_frame tool
server.tool(
  "get_frame",
  "Capture a single frame from an RTSP camera stream and return it as an image. " +
    "Provide either a 'server' name (from the configured RTSP_URLS list) or a full 'url' directly.",
  {
    server: z
      .string()
      .optional()
      .describe(
        "Name of the RTSP source from the configured list. " +
          `Available: ${sources.map((s) => s.name).join(", ") || "(none configured)"}`,
      ),
    url: z
      .string()
      .optional()
      .describe(
        "Direct RTSP URL to capture from (may include credentials, e.g. rtsp://user:pass@host/stream). " +
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
      .describe("Capture timeout in milliseconds (1000–60000, default: 10000)"),
  },
  async ({ server: serverName, url, format, timeout }) => {
    // Resolve the target URL
    let targetUrl = url;

    if (!targetUrl) {
      if (!serverName) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                sources.length > 0
                  ? `Please specify either a 'server' name (${sources.map((s) => `"${s.name}"`).join(", ")}) or a direct 'url'.`
                  : "No RTSP sources are configured in RTSP_URLS. Please provide a 'url' parameter directly.",
            },
          ],
          isError: true,
        };
      }

      const source = sources.find(
        (s) => s.name.toLowerCase() === serverName.toLowerCase(),
      );
      if (!source) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown server "${serverName}". Available: ${sources.map((s) => s.name).join(", ")}`,
            },
          ],
          isError: true,
        };
      }
      targetUrl = source.url;
    }

    try {
      const frame = await grabFrame(targetUrl, format ?? "jpeg", timeout ?? 10000);

      // Determine MIME type
      const mimeMap: Record<string, string> = {
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
      };
      const mime = mimeMap[format ?? "jpeg"] ?? "image/jpeg";

      return {
        content: [
          {
            type: "image" as const,
            data: frame.toString("base64"),
            mimeType: mime,
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to capture frame: ${message}` }],
        isError: true,
      };
    }
  },
);

// List available RTSP sources as a resource
server.resource("rtsp-sources", "rtsp://sources", async (uri) => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(
        sources.map((s) => ({ name: s.name, url: s.url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@") })),
        null,
        2,
      ),
    },
  ],
}));

// Main entry
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("rtsp-mcp-server started (stdio transport)");
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
