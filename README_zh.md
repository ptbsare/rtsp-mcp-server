[English](README.md)

# RTSP MCP Server

MCP (Model Context Protocol) 服务器，用于从 RTSP 视频流中抓取单帧画面。使用 ffmpeg 作为后端。

## 特性

- ✅ 支持多个 RTSP 服务器配置
- ✅ 动态工具描述 — `get_frame` 工具描述自动包含所有配置的摄像头
- ✅ ffmpeg 自动下载 — 系统无 ffmpeg 时自动下载并缓存
- ✅ 多平台支持 — Linux (x64/arm64), Windows (x64/arm64), macOS (需手动安装)
- ✅ SHA256 校验 — 下载的 ffmpeg 二进制文件经过完整性验证
- ✅ 指数退避重试 — 自动重试失败的抓帧操作

## 环境变量

| 变量名 | 必需 | 默认值 | 说明 |
|--------|------|--------|------|
| `RTSP_URLS` | 是 | — | 逗号分隔的 RTSP 服务器列表，格式: `name=url` |
| `RTSP_MAX_RETRIES` | 否 | `3` | 最大重试次数 |
| `RTSP_RETRY_BASE_DELAY_MS` | 否 | `1000` | 重试基础延迟 (毫秒)，指数退避 |

### 示例

```bash
export RTSP_URLS="camera1=rtsp://192.168.1.100/stream1,camera2=rtsp://192.168.1.101/stream2"
```

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

## MCP 工具

### `get_frame`

从 RTSP 服务器抓取单帧画面。

**参数：**
- `server` (string, 可选) — 要抓取的服务器名称（从 `RTSP_URLS` 中配置）
- `format` (string, 可选, 默认: `jpeg`) — 输出格式: `jpeg`, `png`, `webp`

**返回：** JPEG/PNG/WebP 格式的图片数据

### `list_servers`

列出所有配置的 RTSP 服务器。

## 使用方法

```bash
# 安装
npm install -g @ptbsare/rtsp-mcp-server

# 运行
export RTSP_URLS="camera1=rtsp://192.168.1.100/stream1"
rtsp-mcp-server
```

### 配置 MCP 客户端

在 Claude Desktop 或其他 MCP 客户端中配置：

```json
{
  "mcpServers": {
    "rtsp": {
      "command": "rtsp-mcp-server",
      "env": {
        "RTSP_URLS": "camera1=rtsp://192.168.1.100/stream1,camera2=rtsp://192.168.1.101/stream2"
      }
    }
  }
}
```

## 开发

```bash
git clone https://github.com/ptbsare/rtsp-mcp-server.git
cd rtsp-mcp-server
npm install
npm run build
npm start
```

## 许可证

GPLv3
