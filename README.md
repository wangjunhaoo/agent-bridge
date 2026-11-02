# `AgentBridge` — Control your browser with AI Agents

通用 AI 浏览器控制插件与桥接层（支持 Claude Code、Codex、Cursor、Windsurf、Antigravity、OpenClaw 等任意 MCP 客户端及 CLI 脚本）。

## 核心特性

1. **零侵入继承真实登录态**：直接以 Manifest V3 扩展形态运行在日常 Chrome 主 Profile 中，无缝复用 Gmail、GitHub、企业内网 SSO 等全部已登录会话。
2. **深度隐身反检测（Stealth Mode）**：
   - **业务 DOM 零属性污染**：元素引用（`e1, e2...`）完全在 Isolated World 内存中维护，绝不向页面业务节点写入 `data-agent-*` 属性，无惧 `MutationObserver` 与选择器扫描；
   - **Closed Shadow DOM 视觉舞台**：虚拟鼠标与高亮层封装于无 ID 特征的 `mode: "closed"` Shadow Root 中，网页脚本访问 `.shadowRoot` 恒为 `null`；只读感知操作保持静默不挂载节点；
   - **拟人物理事件与坐标微抖动**：点击位置在目标安全盒内按近似正态分布微偏移（Jitter），补全真实 `screenX/screenY` 与按压微延时；
   - **CDP `Runtime.enable` 解耦与后台焦点对齐**：硬件级可信点击与后台截图仅调用最小化 `Input/Page` 域，不启用易触发反爬探针的 `Runtime.enable`；同时自动对齐后台标签页 `visibilityState` 与 `hasFocus()` 状态。
3. **拟真 AI 虚拟鼠标与页面视觉舞台**：
   - 定制蓝黑渐变矢量光标 + 实时动作胶囊标签（密码输入自动脱敏为 `••••••••`），沿二次贝塞尔弧线平滑滑行并带尾迹粒子；
   - 点击瞬间触发双层雷达脉冲波纹与圆角目标吸附高亮框；
   - 视口四周呈现呼吸流光边框，底部提供毛玻璃 HUD 状态胶囊栏。
4. **专属 `AI Agent` 标签组隔离**：通过 `chrome.tabGroups` 自动将受控标签页归拢至彩色标签组（`AI Agent`），默认走原生 `PointerEvent/MouseEvent` 链与 `captureVisibleTab`，**不触发 Chrome 顶部的「已开始调试此浏览器」横幅**。
5. **高吞吐 Agent 效率与完备安全护栏**：
   - 支持紧凑语义快照 DSL（节省约 80% Token）、`<untrusted_page_content>` 间接提示词注入隔离、`browser_batch` 单轮多步复合动作、`browser_wait_for` 条件等待、`browser_upload_file` 本地文件上传、同源 `iframe` 穿透及局部 `overflow` 容器滚动；
   - Unix Socket 强制 `0o600` 权限与长连接多路复用；安全护栏配置锁死仅允许扩展面板修改；严格校验 URL 域名边界并对按钮点击与回车提交双重执行敏感确认拦截。

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

# 在 'AI Agent' 标签组中打开网页
./dist/host/cli.js open https://example.com

# 提取指定标签页的可交互语义快照（支持 --compact 紧凑模式与 --highlight 视觉角标）
./dist/host/cli.js snapshot --compact
./dist/host/cli.js snapshot --highlight

# 让 AI 虚拟鼠标平滑滑行悬停、点击、输入或批量执行
./dist/host/cli.js move e1
./dist/host/cli.js click e1
./dist/host/cli.js fill e2 "AgentBridge" --enter
./dist/host/cli.js batch '[{"action":"fill","ref":"e1","value":"admin"},{"action":"click","ref":"e2"}]'

# 局部容器或页面滚动 / 条件等待 / 文件上传
./dist/host/cli.js scroll 600 --ref e4
./dist/host/cli.js wait "登录成功" --timeout 5000
./dist/host/cli.js upload e5 ./avatar.png

# 网页截图
./dist/host/cli.js screenshot page.png

# 切换隐身反检测模式 / Developer Mode (Full CDP)
./dist/host/cli.js stealth on
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
