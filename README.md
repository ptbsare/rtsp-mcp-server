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

| Variable | Required | Description |
|----------|----------|-------------|
| `RTSP_URLS` | No | Comma-separated list of RTSP URLs. Format: `name=url` or just `url`. Credentials can be embedded in the URL. |

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

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `server` | string | No* | — | Name of a configured RTSP source from `RTSP_URLS` |
| `url` | string | No* | — | Direct RTSP URL (overrides `server`) |
| `format` | `jpeg` / `png` / `webp` | No | `jpeg` | Output image format |
| `timeout` | integer | No | `10000` | Capture timeout in ms (1000–60000) |

\* At least one of `server` or `url` is required.

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

## Resources

### `rtsp://sources`

Returns a JSON list of all configured RTSP sources (credentials are masked).

## Requirements

- Node.js >= 18
- ffmpeg must be installed and available in `PATH`

### Installing ffmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Arch Linux
sudo pacman -S ffmpeg
```

## How It Works

1. On startup, the server parses `RTSP_URLS` into named camera sources
2. When `get_frame` is called, it spawns `ffmpeg` to connect to the RTSP stream via TCP and extract a single frame
3. The captured frame is returned as a base64-encoded image in the MCP response
4. For non-JPEG formats, the frame is converted using [sharp](https://sharp.pixelplumbing.com/)

## License

MIT
