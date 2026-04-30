# @ptbsare/rtsp-mcp-server

[English](./README.md) | [中文](./README_zh.md)

一个 MCP（模型上下文协议）服务器，用于从 RTSP 摄像头视频流中抓取单帧画面。支持所有兼容 RTSP 协议的 IP 摄像头、NVR 和流媒体服务器。

## 功能特性

- **RTSP 抓帧** — 使用 ffmpeg 从任意 RTSP 视频流抓取单帧画面
- **URL 认证** — 支持 RTSP URL 中内嵌认证凭据（`rtsp://user:pass@host/path`）
- **多路源配置** — 通过一个环境变量配置多个命名摄像头
- **多输出格式** — JPEG（默认）、PNG、WebP
- **直连模式** — 无需预配置，直接传入 RTSP URL 抓帧
- **stdio 传输** — 标准 MCP stdio 接口，兼容所有 MCP 客户端

## 快速开始

### npx（推荐）

无需安装，直接运行：

```bash
npx @ptbsare/rtsp-mcp-server
```

### 配置 MCP 客户端

#### Claude Desktop

添加到 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "rtsp": {
      "command": "npx",
      "args": ["-y", "@ptbsare/rtsp-mcp-server"],
      "env": {
        "RTSP_URLS": "前门=rtsp://user:pass@192.168.1.100/stream1,后院=rtsp://192.168.1.101/live"
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
        "RTSP_URLS": "摄像头1=rtsp://user:pass@192.168.1.100/stream1"
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

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `RTSP_URLS` | 否 | — | RTSP URL 列表，分号 `;` 或逗号 `,` 分隔。格式：`name=url` 或直接 `url`。URL 中可内嵌认证信息。 |
| `RTSP_MAX_RETRIES` | 否 | `3` | 抓帧失败时最大重试次数（0 = 不重试）。总尝试次数 = 重试次数 + 1。 |
| `RTSP_RETRY_BASE_DELAY_MS` | 否 | `1000` | 指数退避基础延迟（毫秒）。实际延迟 = `base × 2^(attempt-1)`。 |

### RTSP_URLS 格式

```
# 命名源（推荐）
RTSP_URLS="前门=rtsp://192.168.1.10:554/stream1,后院=rtsp://192.168.1.11:554/live"

# 带认证信息
RTSP_URLS="厨房=rtsp://admin:password123@192.168.1.20:554/h264"

# 混合使用 — 命名和未命名
RTSP_URLS="cam1=rtsp://192.168.1.10/stream,rtsp://192.168.1.11/live"
```

## 工具

### `list_servers`

列出所有通过 `RTSP_URLS` 环境变量配置的 RTSP 视频源。如果不知道有哪些可用的 server 名称，请先调用此工具。

**参数：** 无

**示例输出：**
```
Configured RTSP sources (2):
1. 前门 — rtsp://192.168.1.10:554/stream1
2. 后院 — rtsp://192.168.1.11:554/live

Use the "server" name (e.g. "前门") in the get_frame tool.
```

### `get_frame`

从 RTSP 视频流抓取单帧画面，返回 base64 编码的图像。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `server` | string | 否* | — | `RTSP_URLS` 中配置的 RTSP 源名称 |
| `url` | string | 否* | — | 直接指定 RTSP URL（优先级高于 `server`） |
| `format` | `jpeg` / `png` / `webp` | 否 | `jpeg` | 输出图像格式 |
| `timeout` | integer | 否 | `10000` | 抓帧超时时间，单位毫秒（1000–60000） |

\* `server` 和 `url` 至少需要提供一个。当 `RTSP_URLS` 中仅配置了一个源时，即使省略 `server` 也会自动使用。

**使用示例（在 MCP 客户端中）：**

> "从前门摄像头抓一帧画面"

AI 客户端将调用：
```json
{
  "name": "get_frame",
  "arguments": {
    "server": "前门",
    "format": "jpeg"
  }
}
```

或使用直连 URL：
```json
{
  "name": "get_frame",
  "arguments": {
    "url": "rtsp://admin:pass@192.168.1.100:554/stream1",
    "format": "jpeg"
  }
}
```

## 资源

### `rtsp://sources`

返回所有已配置 RTSP 源的 JSON 列表（认证凭据已脱敏）。

## 依赖要求

- Node.js >= 18
- 系统已安装 ffmpeg 并在 `PATH` 中

### 安装 ffmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Arch Linux
sudo pacman -S ffmpeg
```

## 工作原理

1. 启动时解析 `RTSP_URLS` 环境变量，生成命名摄像头列表
2. 调用 `get_frame` 时，启动 `ffmpeg` 通过 TCP 连接 RTSP 视频流并提取单帧画面
3. 抓取的画面以 base64 编码图像的形式通过 MCP 响应返回
4. 非 JPEG 格式会通过 [sharp](https://sharp.pixelplumbing.com/) 进行转换

## 许可证

MIT
