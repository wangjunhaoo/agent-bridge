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
  | "dom.waitFor"
  | "dom.batch"
  | "dom.uploadFile"
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
  /** Stealth 隐身反检测模式：零业务 DOM 属性修改、闭合 Shadow DOM、拟人坐标抖动与后台可见性对齐 */
  stealthMode: boolean;
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
  stealthMode: true,
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

/**
 * 严格匹配 URL 与规则模式（区分协议前缀与精确域名/子域名后缀，防止 ?redirect=allowed.com 或 allowed.com.evil.com 绕过）
 */
export function matchesDomainOrPrefixPattern(rawUrl: string, rawPattern: string): boolean {
  const pattern = rawPattern.trim().toLowerCase();
  if (!pattern) return false;
  const lowerUrl = rawUrl.trim().toLowerCase();

  if (pattern.includes("://")) {
    return lowerUrl.startsWith(pattern);
  }

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const slashIdx = pattern.indexOf("/");
    const domainPart = (slashIdx === -1 ? pattern : pattern.slice(0, slashIdx)).replace(/^\*\./, "");
    const pathPart = slashIdx === -1 ? "" : pattern.slice(slashIdx);

    const hostMatched = host === domainPart || host.endsWith(`.${domainPart}`);
    if (!hostMatched) return false;
    if (pathPart) {
      return parsed.pathname.toLowerCase().startsWith(pathPart);
    }
    return true;
  } catch {
    return lowerUrl.startsWith(pattern);
  }
}

export function isUrlAllowed(url: string | undefined, config: ExtensionGuardConfig): {
  allowed: boolean;
  reason?: string;
} {
  if (!url || url === "about:blank") return { allowed: true };

  for (const blocked of config.blockedDomains) {
    if (matchesDomainOrPrefixPattern(url, blocked)) {
      return {
        allowed: false,
        reason: `URL "${url}" matches blocked domain/prefix "${blocked}"`
      };
    }
  }

  if (config.allowedDomains.length > 0) {
    let matched = false;
    for (const allowed of config.allowedDomains) {
      if (matchesDomainOrPrefixPattern(url, allowed)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return {
        allowed: false,
        reason: `URL "${url}" is not in allowedDomains list`
      };
    }
  }

  return { allowed: true };
}

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

export interface BatchActionStep {
  action: "click" | "fill" | "select" | "press" | "scroll" | "waitFor" | "moveCursor";
  ref?: string;
  selector?: string;
  value?: string;
  key?: string;
  clear?: boolean;
  pressEnter?: boolean;
  confirmed?: boolean;
  deltaX?: number;
  deltaY?: number;
  text?: string;
  timeoutMs?: number;
  x?: number;
  y?: number;
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
