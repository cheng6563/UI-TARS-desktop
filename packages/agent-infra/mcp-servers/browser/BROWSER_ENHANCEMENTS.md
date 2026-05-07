# Browser MCP Server 增强改动

## 概述

对 `@agent-infra/mcp-server-browser` 进行了四项增强，解决了原包的功能缺陷。

## 改动清单

### 1. 修复默认 viewport 为 0x0 的问题
- **文件**: `src/index.ts`
- **改动**: 当未提供 `viewportSize` 时，`defaultViewport` 从 `{width: 0, height: 0, deviceScaleFactor: 0}` 改为 `{width: 1280, height: 720}`
- **原因**: 原来没有 args 设置 viewport 时浏览器窗口为 0x0，页面无法正常渲染

### 2. 新增运行时设置分辨率工具 `browser_set_viewport`
- **文件**: `src/server.ts`
- **参数**:
  - `width` (number, 必填): 视口宽度像素
  - `height` (number, 必填): 视口高度像素
  - `deviceScaleFactor` (number, 可选, 默认 1): 设备缩放因子
- **说明**: 原生仅支持启动时通过 `--viewport-size` 或 HTTP header `x-viewport-size` 设置。stdio 模式下无法运行时动态改变，此工具弥补该缺陷

### 3. 新增 console 日志捕获
- **文件**: `src/utils/browser.ts`, `src/resources/index.ts`, `src/context.ts`, `src/server.ts`, `src/tools/tabs.ts`
- **改动**:
  - 在 `browser.ts` 新增 `attachPageListeners(page)` 函数，通过 `page.on('console', ...)` 捕获所有 console 输出
  - 页面创建、新标签页、popup 页面均自动注册监听器
  - 新增工具 `browser_get_console_logs` (支持 `filter` 参数过滤)
  - 已有 `console://logs` MCP Resource 现在能真正返回数据

### 4. 新增网络请求历史捕获
- **文件**: `src/utils/browser.ts`, `src/resources/index.ts`, `src/server.ts`
- **改动**:
  - 新增 `networkRequests` 数组，通过 `page.on('request', ...)` 和 `page.on('response', ...)` 捕获请求和响应
  - 记录内容：URL、方法、状态码、请求/响应头、响应体（上限 500KB，最多保留 500 条）
  - 新增工具 `browser_get_network_requests`，支持过滤参数：
    - `urlFilter`: URL 子串过滤
    - `methodFilter`: HTTP 方法过滤
    - `statusFilter`: 状态码过滤
    - `includeResponseBody`: 是否包含响应体（默认 true）
    - `limit`: 返回条数限制（默认 50）

### 5. 新增日志清理工具 `browser_clear_logs`
- **文件**: `src/server.ts`
- **说明**: 一键清空 console 日志和网络请求历史

## 新增工具一览

| 工具名 | 说明 |
|--------|------|
| `browser_set_viewport` | 运行时设置浏览器分辨率 |
| `browser_get_console_logs` | 获取 console 日志历史 |
| `browser_get_network_requests` | 获取网络请求历史（含响应体） |
| `browser_clear_logs` | 清空所有日志历史 |

## 构建说明

```bash
cd packages/agent-infra/mcp-servers/browser
npm run build
```

构建产物在 `dist/` 目录下。要让 Claude Code 使用修改后的版本，需将 `.claude.json` 中的 MCP 配置改为本地路径：

```json
"browser": {
  "type": "stdio",
  "command": "node",
  "args": [
    "C:/code/UI-TARS-desktop/packages/agent-infra/mcp-servers/browser/dist/index.cjs"
  ],
  "env": {}
}
```
