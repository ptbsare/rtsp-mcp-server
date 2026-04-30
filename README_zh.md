[English](./README.md) | 中文

# @ptbsare/rtsp-mcp-server

一个 MCP（模型上下文协议）服务器，用于从 RTSP 摄像头视频流中抓取画面。支持所有兼容 RTSP 协议的 IP 摄像头、NVR 和流媒体服务器。

## 功能特性

- **RTSP 抓帧** — 使用 ffmpeg 从任意 RTSP 视频流抓取单帧或连续多帧画面
- **URL 认证** — 支持 RTSP URL 中内嵌认证凭据（`rtsp://user:pass@host/path`）
- **多路源配置** — 通过一个环境变量配置多个命名摄像头
- **动态工具描述** — `get_frame` / `get_frames` 工具描述自动包含所有已配置摄像头名称，客户端通过 `tools/list` 即可获知
- **多输出格式** — JPEG（默认）、PNG、WebP
- **直连模式** — 无需预配置，直接传入 RTSP URL 抓帧
- **指数退避重试** — 失败时自动重试（默认 3 次），可配置
- **ffmpeg 自动管理** — 系统无 ffmpeg 时自动下载并缓存（SHA256 校验）
- **多平台支持** — Linux x64/arm64、Windows x64/arm64 自动下载；macOS 需手动安装
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
RTSP_URLS="前门=rtsp://192.168.1.10:554/stream1;后院=rtsp://192.168.1.11:554/live"

# 带认证信息
RTSP_URLS="厨房=rtsp://admin:password123@192.168.1.20:554/h264"

# 混合使用 — 命名和未命名
RTSP_URLS="cam1=rtsp://192.168.1.10/stream,rtsp://192.168.1.11/live"
```

## 工具

### `get_frame`

从 RTSP 视频流抓取单帧画面，返回 base64 编码的图像。

工具描述在启动时动态生成，内嵌所有配置的摄像头名称 — 客户端通过 `tools/list` 即可知道所有可用的 server 名称。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `server` | string | 否* | — | `RTSP_URLS` 中配置的 RTSP 源名称 |
| `url` | string | 否* | — | 直接指定 RTSP URL（优先级高于 `server`） |
| `format` | `jpeg` / `png` / `webp` | 否 | `jpeg` | 输出图像格式 |
| `timeout` | integer | 否 | `10000` | 每次尝试的抓帧超时，单位毫秒（1000–60000） |

\* `server` 和 `url` 至少需要提供一个。当 `RTSP_URLS` 中仅配置了一个源时，即使省略 `server` 也会自动使用。

### `get_frames`

从 RTSP 视频流连续抓取多帧画面，返回一组连续的图像。

工具描述在启动时动态生成，内嵌所有配置的摄像头名称。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `server` | string | 否* | — | `RTSP_URLS` 中配置的 RTSP 源名称 |
| `url` | string | 否* | — | 直接指定 RTSP URL（优先级高于 `server`） |
| `count` | integer | 否 | `7` | 抓取帧数（1–30） |
| `fps` | number | 否 | `1` | 每秒帧数（0.1–10）。总时长 = count / fps |
| `format` | `jpeg` / `png` / `webp` | 否 | `jpeg` | 输出图像格式 |
| `timeout` | integer | 否 | `30000` | 总抓取超时，单位毫秒（1000–120000） |

\* `server` 和 `url` 至少需要提供一个。当 `RTSP_URLS` 中仅配置了一个源时，即使省略 `server` 也会自动使用。

**使用示例（在 MCP 客户端中）：**

> "从前门摄像头每 2 秒抓一帧，共抓 5 帧"

AI 客户端将调用：
```json
{
  "name": "get_frames",
  "arguments": {
    "server": "前门",
    "count": 5,
    "fps": 0.5
  }
}
```

> "从后院摄像头抓 3 帧画面"

```json
{
  "name": "get_frames",
  "arguments": {
    "server": "后院",
    "count": 3
  }
}
```

## 资源

### `rtsp://sources`

返回所有已配置 RTSP 源的 JSON 列表（认证凭据已脱敏）。

## 依赖要求

- Node.js >= 18
- ffmpeg（自动管理 — 见下方说明）

## ffmpeg 自动管理

服务器启动时按以下优先级查找 ffmpeg：

1. **系统 ffmpeg** — 如果 `PATH` 中存在 `ffmpeg`，直接使用（最快，零配置）
2. **缓存二进制文件** — 检查 `~/.rtsp-mcp-server/bin/ffmpeg`（Linux/macOS）或 `%USERPROFILE%\.rtsp-mcp-server\bin\ffmpeg.exe`（Windows）
3. **自动下载** — 在支持的平台上，服务器自动从 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest) 下载 GPL 静态编译版本，校验 SHA256 后缓存。仅首次下载，后续复用缓存
4. **需手动安装** — 不支持的平台会报错并给出安装指引

支持自动下载的平台：

| 平台 | 架构 | 归档格式 |
|------|------|----------|
| Linux | x64 | tar.xz |
| Linux | arm64 | tar.xz |
| Windows | x64 | zip |
| Windows | arm64 | zip |

macOS **不支持**自动下载（上游无构建），请通过 `brew install ffmpeg` 安装。

### 手动安装 ffmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Arch Linux
sudo pacman -S ffmpeg

# Windows — 从以下地址下载静态编译版本：
# https://github.com/BtbN/FFmpeg-Builds/releases
# 将 ffmpeg.exe 放到缓存目录：
#   %USERPROFILE%\.rtsp-mcp-server\bin\ffmpeg.exe
```

### ffmpeg 缓存位置

| 平台 | 路径 |
|------|------|
| Linux / macOS | `~/.rtsp-mcp-server/bin/ffmpeg` |
| Windows | `%USERPROFILE%\.rtsp-mcp-server\bin\ffmpeg.exe` |

如需重新下载，删除缓存的二进制文件后重启服务器即可。

## 工作原理

1. 启动时检查系统 ffmpeg → 缓存 ffmpeg → 自动下载 ffmpeg（详见"ffmpeg 自动管理"）
2. 解析 `RTSP_URLS` 环境变量，生成命名摄像头列表
3. `get_frame` 和 `get_frames` 工具描述在启动时动态生成，内嵌所有摄像头名称 — `tools/list` 即可让客户端知道所有可用服务器
4. 调用 `get_frame` 时，启动 ffmpeg 通过 TCP 连接 RTSP 视频流并提取单帧画面
5. 调用 `get_frames` 时，使用 ffmpeg 的 fps 滤镜按指定帧率连续抓取多帧，通过 JPEG 边界（FF D8/FF D9）解析分帧
6. 失败时自动指数退避重试，最多 `RTSP_MAX_RETRIES` 次
7. 非 JPEG 格式会通过 [sharp](https://sharp.pixelplumbing.com/) 进行转换

## 许可证

GPLv3
