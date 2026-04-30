# @ptbsare/rtsp-mcp-server

[English](./README.md) | [中文](./README_zh.md)

An MCP (Model Context Protocol) server for capturing single frames from RTSP camera streams. Works with any RTSP-compatible IP camera, NVR, or streaming server.

## Features

- **RTSP frame capture** — grab a single frame from any RTSP stream using ffmpeg
- **URL authentication** — supports RTSP URLs with embedded credentials (`rtsp://user:pass@host/path`)
- **Multiple sources** — configure multiple named cameras via a single environment variable
- **Multiple output formats** — JPEG (default), PNG, WebP
- **Direct URL mode** — capture from any RTSP URL without pre-configuration
- **stdio transport** — standard MCP stdio interface, works with any MCP client
- **Auto ffmpeg download** — automatically downloads and caches a static ffmpeg binary when not found in PATH (Linux x64/arm64, Windows x64/arm64; SHA256 verified)

## Quick Start

### npx (recommended)

No installation required:

```bash
npx @ptbsare/rtsp-mcp-server
```

### Configure your MCP client

#### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rtsp": {
      "command": "npx",
      "args": ["-y", "@ptbsare/rtsp-mcp-server"],
      "env": {
        "RTSP_URLS": "camera1=rtsp://user:pass@192.168.1.100/stream1,camera2=rtsp://192.168.1.101/live"
      }
    }
  }
}
```

#### Claude Code

```json
{
  "mcpServers": {
    "rtsp": {
      "command": "npx",
      "args": ["-y", "@ptbsare/rtsp-mcp-server"],
      "env": {
        "RTSP_URLS": "camera1=rtsp://user:pass@192.168.1.100/stream1"
      }
    }
  }
}
```

#### Zed

```json
{
  "context_servers": {
    "rtsp": {
      "command": {
        "path": "npx",
        "args": ["-y", "@ptbsare/rtsp-mcp-server"]
      },
      "settings": {
        "env": {
          "RTSP_URLS": "camera1=rtsp://user:pass@192.168.1.100/stream1"
        }
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RTSP_URLS` | No | — | RTSP URL list. Format: `name=url`, separated by commas or semicolons. Credentials can be embedded in the URL. |
| `RTSP_MAX_RETRIES` | No | `3` | Max retry attempts on capture failure (0 = no retry). Total attempts = retries + 1. |
| `RTSP_RETRY_BASE_DELAY_MS` | No | `1000` | Base delay (ms) for exponential backoff between retries. Actual delay = `base × 2^(attempt-1)`. |

### RTSP_URLS Format

```
# Named sources (recommended)
RTSP_URLS="front_door=rtsp://192.168.1.10:554/stream1,backyard=rtsp://192.168.1.11:554/live"

# With authentication
RTSP_URLS="kitchen=rtsp://admin:password123@192.168.1.20:554/h264"

# Mixed — named and unnamed
RTSP_URLS="cam1=rtsp://192.168.1.10/stream,rtsp://192.168.1.11/live"
```

## Tools

### `get_frame`

Capture a single frame from an RTSP stream and return it as a base64-encoded image.

The tool description is generated dynamically at startup — it always lists every camera name configured in `RTSP_URLS`, so the AI client already knows all available servers from `tools/list` without a separate discovery call.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `server` | string | No* | — | Name of a configured RTSP source from `RTSP_URLS` |
| `url` | string | No* | — | Direct RTSP URL (overrides `server`) |
| `format` | `jpeg` / `png` / `webp` | No | `jpeg` | Output image format |
| `timeout` | integer | No | `10000` | Capture timeout in ms (1000–60000) |

\* At least one of `server` or `url` is required. When only one source is configured in `RTSP_URLS`, it will be used automatically even if `server` is omitted.

**Example usage in an MCP client:**

> "Capture a frame from the front door camera"

The AI client will call:
```json
{
  "name": "get_frame",
  "arguments": {
    "server": "front_door",
    "format": "jpeg"
  }
}
```

Or with a direct URL:
```json
{
  "name": "get_frame",
  "arguments": {
    "url": "rtsp://admin:pass@192.168.1.100:554/stream1",
    "format": "jpeg"
  }
}
```

### `get_frames`

Capture multiple consecutive frames from an RTSP stream and return them as a sequence of images.

The tool description is generated dynamically at startup — it lists every camera name configured in `RTSP_URLS`.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `server` | string | No* | — | Name of a configured RTSP source from `RTSP_URLS` |
| `url` | string | No* | — | Direct RTSP URL (overrides `server`) |
| `count` | integer | No | `7` | Number of frames to capture (1–30) |
| `fps` | number | No | `1` | Frames per second (0.1–10). Total duration = count / fps |
| `format` | `jpeg` / `png` / `webp` | No | `jpeg` | Output image format |
| `timeout` | integer | No | `30000` | Total capture timeout in ms (1000–120000) |

\* At least one of `server` or `url` is required. When only one source is configured in `RTSP_URLS`, it will be used automatically even if `server` is omitted.

**Example — capture a frame every 2 seconds for 10 seconds (5 frames):**
```json
{
  "name": "get_frames",
  "arguments": {
    "server": "front_door",
    "count": 5,
    "fps": 0.5
  }
}
```

**Example — capture 3 frames at 1-second intervals (default behavior):**
```json
{
  "name": "get_frames",
  "arguments": {
    "server": "backyard",
    "count": 3
  }
}
```

## Resources

### `rtsp://sources`

Returns a JSON list of all configured RTSP sources (credentials are masked).

## Requirements

- Node.js >= 18
- ffmpeg (auto-managed — see below)

## ffmpeg Management

On startup the server resolves an ffmpeg binary in this order:

1. **System ffmpeg** — if `ffmpeg` is found in `PATH`, it is used directly (fastest, zero setup).
2. **Cached binary** — checks `~/.rtsp-mcp-server/bin/ffmpeg` (Linux/macOS) or `%USERPROFILE%\.rtsp-mcp-server\bin\ffmpeg.exe` (Windows) from a previous auto-download.
3. **Auto-download** — on supported platforms, the server downloads a static GPL build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest), verifies its SHA256 against the published `checksums.sha256`, and caches the binary. This only happens once; subsequent runs reuse the cache.

Supported auto-download platforms:

| Platform | Architecture | Archive format |
|----------|-------------|----------------|
| Linux | x64 | tar.xz |
| Linux | arm64 | tar.xz |
| Windows | x64 | zip |
| Windows | arm64 | zip |

macOS is **not** supported for auto-download (no builds are provided upstream). Install via `brew install ffmpeg`.

4. **Manual install required** — on unsupported platforms, the server throws an error with install instructions.

### Installing ffmpeg manually

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Arch Linux
sudo pacman -S ffmpeg

# Windows — download a static build from:
# https://github.com/BtbN/FFmpeg-Builds/releases
# Then place ffmpeg.exe in the server cache directory:
#   %USERPROFILE%\.rtsp-mcp-server\bin\ffmpeg.exe
```

### ffmpeg cache location

| Platform | Path |
|----------|------|
| Linux / macOS | `~/.rtsp-mcp-server/bin/ffmpeg` |
| Windows | `%USERPROFILE%\.rtsp-mcp-server\bin\ffmpeg.exe` |

To force a fresh download, simply delete the cached binary and restart the server.

## How It Works

1. On startup, the server parses `RTSP_URLS` into named camera sources
2. The `get_frame` tool description is generated dynamically at startup, embedding all configured camera names — so `tools/list` already tells the client exactly which servers are available
3. When `get_frame` is called, it spawns `ffmpeg` to connect to the RTSP stream via TCP and extract a single frame
4. The captured frame is returned as a base64-encoded image in the MCP response
5. On failure, the capture is retried with exponential backoff up to `RTSP_MAX_RETRIES` times
6. For non-JPEG formats, the frame is converted using [sharp](https://sharp.pixelplumbing.com/)

## License

GPLv3
