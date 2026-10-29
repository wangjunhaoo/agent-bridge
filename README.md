# `AgentBridge` — Control your browser with AI Agents

通用 AI 浏览器控制插件与桥接层（支持 Claude Code、Codex、Cursor、Windsurf、Antigravity、OpenClaw 等任意 MCP 客户端及 CLI 脚本）。

## 核心特性

1. **零侵入继承真实登录态**：直接以 Manifest V3 扩展形态运行在日常 Chrome 主 Profile 中，无缝复用 Gmail、GitHub、企业内网 SSO 等全部已登录会话。
2. **拟真 AI 虚拟鼠标与页面视觉舞台（Shadow DOM 隔离）**：
   - 定制蓝黑渐变矢量光标 + 实时动作胶囊标签（如 `点击 · 登录`、`输入 "..."`），沿二次贝塞尔弧线平滑滑行并带尾迹粒子；
   - 点击瞬间触发双层雷达脉冲波纹与圆角目标吸附高亮框；
   - 视口四周呈现呼吸流光边框，底部提供毛玻璃 HUD 状态胶囊栏。
3. **专属 `AI Agent` 标签组隔离**：通过 `chrome.tabGroups` 自动将受控标签页归拢至彩色标签组（`AI Agent`），默认走原生 `PointerEvent/MouseEvent` 链与 `captureVisibleTab`，**不触发 Chrome 顶部的「已开始调试此浏览器」横幅**。
4. **Native Messaging + Unix Socket 多路复用安全桥**：扩展通过 `chrome.runtime.connectNative("com.agentbridge.chrome")` 与本地伴生进程通信，并通过 `~/.agent-bridge/bridge.sock` 同时支持 **MCP Server** 与 **CLI** 并发调用。
5. **按需开启 Developer Mode（Full CDP）**：开启后挂载 `chrome.debugger`（CDP 1.3），实时捕获 `Network` 请求与响应体、`Console`/`Runtime` 异常堆栈、`Performance` 指标及任意原始 CDP 指令。

---

## 快速上手

### 1. 构建并注册 Native Messaging Host

```bash
pnpm install
pnpm run build
pnpm run install-host
```

### 2. 在 Chrome 中加载扩展

1. 打开 Chrome 访问 `chrome://extensions/`
2. 开启右上角「开发者模式（Developer mode）」
3. 点击左上角「加载已解压的扩展程序（Load unpacked）」，选择本项目构建产物目录：
   `dist/extension`

### 3. CLI 常用命令

```bash
# 查看扩展与桥接连接状态 / 热重载扩展
./dist/host/cli.js status
./dist/host/cli.js reload

# 列出所有打开的标签页
./dist/host/cli.js tabs

# 在 'AI Agent' 标签组中打开网页并展示 AI 鼠标舞台
./dist/host/cli.js open https://example.com

# 提取指定标签页的可交互语义快照并在页面绘制 Set-of-Mark (#e1, #e2) 视觉标记
./dist/host/cli.js snapshot --highlight

# 让 AI 虚拟鼠标平滑滑行悬停或点击元素
./dist/host/cli.js move e1
./dist/host/cli.js click e1
./dist/host/cli.js fill e2 "AgentBridge" --enter

# 网页截图
./dist/host/cli.js screenshot page.png

# 按需开启/关闭 Developer Mode (Full CDP) 查看控制台异常与网络抓包
./dist/host/cli.js dev on
./dist/host/cli.js console
./dist/host/cli.js network --errors
./dist/host/cli.js dev off
```

### 4. 配置为通用 MCP Server（Claude Code / Codex / Cursor / Antigravity）

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["/Users/wangjunhao/Code/project/agent-bridge/dist/host/cli.js", "mcp"]
    }
  }
}
```
