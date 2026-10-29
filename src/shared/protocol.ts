/**
 * 跨层统一通信协议（Extension <-> Native Host <-> Unix Socket <-> MCP / CLI）
 */

export type BridgeCommandMethod =
  | "bridge.ping"
  | "bridge.status"
  | "bridge.reload"
  | "guard.getConfig"
  | "guard.updateConfig"
  | "tabs.list"
  | "tabs.open"
  | "tabs.read"
  | "tabs.group"
  | "tabs.activate"
  | "tabs.close"
  | "tabs.navigate"
  | "dom.snapshot"
  | "dom.moveCursor"
  | "dom.click"
  | "dom.fill"
  | "dom.select"
  | "dom.press"
  | "dom.scroll"
  | "dom.clearHighlights"
  | "page.screenshot"
  | "dev.getConsoleLogs"
  | "dev.getNetworkRequests"
  | "dev.getNetworkResponseBody"
  | "dev.getPerformanceMetrics"
  | "dev.sendCdpCommand";

export interface RpcRequest<TParams = Record<string, unknown>> {
  id: string;
  method: BridgeCommandMethod | string;
  params?: TParams;
}

export interface RpcResponse<TResult = unknown> {
  id: string;
  ok: boolean;
  result?: TResult;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ExtensionGuardConfig {
  /** 总开关：Control your browser with AI Agents */
  enabled: boolean;
  /** Developer Mode：是否启用 Full CDP 深度访问（Network/Console/Performance/Raw CDP） */
  developerMode: boolean;
  /** 敏感动作（表单提交、发送、删除、支付）前是否拦截并要求确认 */
  confirmBeforeSubmit: boolean;
  /** 专属标签组名称 */
  agentTabGroupTitle: string;
  /** 专属标签组颜色 */
  agentTabGroupColor: "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";
  /** 禁止访问的域名或 URL 前缀黑名单 */
  blockedDomains: string[];
  /** 若非空，则仅允许白名单内的域名被控制 */
  allowedDomains: string[];
}

export const DEFAULT_GUARD_CONFIG: ExtensionGuardConfig = {
  enabled: true,
  developerMode: false,
  confirmBeforeSubmit: true,
  agentTabGroupTitle: "AI Agent",
  agentTabGroupColor: "blue",
  blockedDomains: [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "brave://",
    "1password.com",
    "bitwarden.com"
  ],
  allowedDomains: []
};

export interface TabSummary {
  id: number;
  windowId: number;
  groupId: number;
  index: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  status?: string;
  audible?: boolean;
  debuggerAttached: boolean;
}

export interface InteractiveElementNode {
  /** 页面内唯一短引用 ID，如 e1, e2 */
  ref: string;
  tagName: string;
  role: string;
  name: string;
  text: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  checked?: boolean;
  disabled: boolean;
  /** 是否属于高敏提交/发送/删除/支付类动作 */
  isSensitiveSubmit: boolean;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface PageSnapshotResult {
  tabId: number;
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    scrollHeight: number;
  };
  markdownExcerpt: string;
  elements: InteractiveElementNode[];
  highlighted: boolean;
}

export interface ConsoleLogEntry {
  timestamp: number;
  level: "log" | "info" | "warn" | "error" | "debug" | "exception";
  text: string;
  url?: string;
  lineNumber?: number;
  stackTrace?: string;
}

export interface NetworkRequestEntry {
  requestId: string;
  timestamp: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  durationMs?: number;
  errorText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export interface AuditLogItem {
  id: string;
  timestamp: number;
  method: string;
  tabId?: number;
  summary: string;
  status: "ok" | "blocked" | "error";
}
