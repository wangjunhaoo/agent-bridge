import { NATIVE_HOST_NAME } from "../shared/extension-identity.js";
import {
  DEFAULT_GUARD_CONFIG,
  type AuditLogItem,
  type ConsoleLogEntry,
  type ExtensionGuardConfig,
  type NetworkRequestEntry,
  type PageSnapshotResult,
  type RpcRequest,
  type RpcResponse,
  type TabSummary
} from "../shared/protocol.js";

interface TabTelemetryState {
  attached: boolean;
  domainsEnabled: boolean;
  consoleLogs: ConsoleLogEntry[];
  networkRequests: Map<string, NetworkRequestEntry>;
  networkOrder: string[];
}

const MAX_TELEMETRY_ITEMS = 200;
const MAX_AUDIT_LOGS = 60;
const RECONNECT_ALARM_NAME = "ab-native-reconnect";

let nativePort: chrome.runtime.Port | null = null;
let nativeConnected = false;
let lastNativeError: string | null = null;
let guardConfig: ExtensionGuardConfig = { ...DEFAULT_GUARD_CONFIG };
const tabTelemetry = new Map<number, TabTelemetryState>();
const auditLogs: AuditLogItem[] = [];

async function loadGuardConfig(): Promise<ExtensionGuardConfig> {
  try {
    const stored = await chrome.storage.local.get("guardConfig");
    if (stored.guardConfig) {
      guardConfig = { ...DEFAULT_GUARD_CONFIG, ...stored.guardConfig };
      if (guardConfig.agentTabGroupTitle === "AGY Agent") {
        guardConfig.agentTabGroupTitle = DEFAULT_GUARD_CONFIG.agentTabGroupTitle;
        await chrome.storage.local.set({ guardConfig });
      }
    }
  } catch {
    // storage 读取失败时保持默认内存配置
  }
  return guardConfig;
}

async function saveGuardConfig(partial: Partial<ExtensionGuardConfig>): Promise<ExtensionGuardConfig> {
  guardConfig = { ...guardConfig, ...partial };
  await chrome.storage.local.set({ guardConfig });
  if (!guardConfig.developerMode) {
    await detachAllDebuggers();
  }
  broadcastUiState();
  return guardConfig;
}

async function detachAllDebuggers(): Promise<void> {
  for (const [tabId, state] of tabTelemetry.entries()) {
    if (state.attached) {
      await new Promise<void>((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
      state.attached = false;
      state.domainsEnabled = false;
    }
  }
}

function recordAudit(method: string, summary: string, status: AuditLogItem["status"], tabId?: number): void {
  auditLogs.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    method,
    tabId,
    summary,
    status
  });
  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.length = MAX_AUDIT_LOGS;
  }
  broadcastUiState();
}

function broadcastUiState(): void {
  chrome.runtime
    .sendMessage({
      type: "ab-ui:state",
      payload: {
        nativeConnected,
        lastNativeError,
        guardConfig,
        attachedTabs: Array.from(tabTelemetry.entries())
          .filter(([, v]) => v.attached)
          .map(([tabId]) => tabId),
        auditLogs
      }
    })
    .catch(() => {
      // 当 Popup 或 SidePanel 未打开时忽略错误
    });
}

export function isUrlAllowed(url: string | undefined, config: ExtensionGuardConfig): {
  allowed: boolean;
  reason?: string;
} {
  if (!url) return { allowed: true };
  const lower = url.toLowerCase();

  for (const blocked of config.blockedDomains) {
    const pattern = blocked.trim().toLowerCase();
    if (!pattern) continue;
    if (lower.startsWith(pattern) || lower.includes(pattern)) {
      return {
        allowed: false,
        reason: `URL "${url}" matches blocked domain/prefix "${blocked}"`
      };
    }
  }

  if (config.allowedDomains.length > 0) {
    let matched = false;
    for (const allowed of config.allowedDomains) {
      const pattern = allowed.trim().toLowerCase();
      if (!pattern) continue;
      if (lower.includes(pattern)) {
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

function getOrCreateTelemetry(tabId: number): TabTelemetryState {
  let state = tabTelemetry.get(tabId);
  if (!state) {
    state = {
      attached: false,
      domainsEnabled: false,
      consoleLogs: [],
      networkRequests: new Map(),
      networkOrder: []
    };
    tabTelemetry.set(tabId, state);
  }
  return state;
}

function pushConsoleLog(tabId: number, entry: ConsoleLogEntry): void {
  const state = getOrCreateTelemetry(tabId);
  state.consoleLogs.push(entry);
  if (state.consoleLogs.length > MAX_TELEMETRY_ITEMS) {
    state.consoleLogs.shift();
  }
}

function upsertNetworkRequest(tabId: number, requestId: string, updater: (prev?: NetworkRequestEntry) => NetworkRequestEntry): void {
  const state = getOrCreateTelemetry(tabId);
  const existing = state.networkRequests.get(requestId);
  const next = updater(existing);
  state.networkRequests.set(requestId, next);
  if (!existing) {
    state.networkOrder.push(requestId);
    if (state.networkOrder.length > MAX_TELEMETRY_ITEMS) {
      const oldest = state.networkOrder.shift();
      if (oldest) state.networkRequests.delete(oldest);
    }
  }
}

// 监听 CDP 调试事件（Network / Console / Runtime 异常）
chrome.debugger.onEvent.addListener((source, method, params: any) => {
  const tabId = source.tabId;
  if (!tabId) return;

  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || [])
      .map((arg: any) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type))
      .join(" ");
    const topFrame = params.stackTrace?.callFrames?.[0];
    pushConsoleLog(tabId, {
      timestamp: Date.now(),
      level: params.type || "log",
      text,
      url: topFrame?.url,
      lineNumber: topFrame?.lineNumber
    });
  } else if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails || {};
    const exceptionText = details.exception?.description || details.text || "Uncaught exception";
    pushConsoleLog(tabId, {
      timestamp: Date.now(),
      level: "exception",
      text: exceptionText,
      url: details.url,
      lineNumber: details.lineNumber,
      stackTrace: details.stackTrace
        ? JSON.stringify(details.stackTrace.callFrames?.slice(0, 5))
        : undefined
    });
  } else if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    pushConsoleLog(tabId, {
      timestamp: Date.now(),
      level: entry.level || "info",
      text: entry.text || "",
      url: entry.url,
      lineNumber: entry.lineNumber
    });
  } else if (method === "Network.requestWillBeSent") {
    const req = params.request || {};
    upsertNetworkRequest(tabId, params.requestId, (prev) => ({
      requestId: params.requestId,
      timestamp: Date.now(),
      method: req.method || "GET",
      url: req.url || "",
      resourceType: params.type || prev?.resourceType || "Other",
      requestHeaders: req.headers
    }));
  } else if (method === "Network.responseReceived") {
    const res = params.response || {};
    upsertNetworkRequest(tabId, params.requestId, (prev) => ({
      requestId: params.requestId,
      timestamp: prev?.timestamp || Date.now(),
      method: prev?.method || "GET",
      url: res.url || prev?.url || "",
      resourceType: params.type || prev?.resourceType || "Other",
      status: res.status,
      statusText: res.statusText,
      mimeType: res.mimeType,
      durationMs: prev ? Date.now() - prev.timestamp : undefined,
      requestHeaders: prev?.requestHeaders,
      responseHeaders: res.headers
    }));
  } else if (method === "Network.loadingFailed") {
    upsertNetworkRequest(tabId, params.requestId, (prev) => ({
      requestId: params.requestId,
      timestamp: prev?.timestamp || Date.now(),
      method: prev?.method || "GET",
      url: prev?.url || "",
      resourceType: params.type || prev?.resourceType || "Other",
      status: prev?.status ?? 0,
      errorText: params.errorText || "Network loading failed",
      durationMs: prev ? Date.now() - prev.timestamp : undefined
    }));
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    const state = tabTelemetry.get(source.tabId);
    if (state) {
      state.attached = false;
      state.domainsEnabled = false;
    }
    broadcastUiState();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabTelemetry.delete(tabId);
});

async function sendCdp<T = any>(tabId: number, method: string, commandParams: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, commandParams, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result as T);
    });
  });
}

async function ensureDebuggerAttached(tabId: number, enableTelemetryDomains = true): Promise<void> {
  const state = getOrCreateTelemetry(tabId);
  if (!state.attached) {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "";
          if (msg.includes("Already attached")) {
            resolve();
            return;
          }
          reject(new Error(msg));
          return;
        }
        resolve();
      });
    });
    state.attached = true;
    broadcastUiState();
  }

  if (enableTelemetryDomains && guardConfig.developerMode && !state.domainsEnabled) {
    state.domainsEnabled = true;
    await Promise.allSettled([
      sendCdp(tabId, "Runtime.enable"),
      sendCdp(tabId, "Log.enable"),
      sendCdp(tabId, "Network.enable", { maxPostDataSize: 65536 }),
      sendCdp(tabId, "Page.enable"),
      sendCdp(tabId, "Performance.enable")
    ]);
  }
}

async function resolveTargetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (typeof tabId === "number") {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found`);
    return tab;
  }
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.id !== undefined) return activeTab;

  const allTabs = await chrome.tabs.query({});
  const fallback = allTabs.find((t) => t.id !== undefined && t.url && !t.url.startsWith("chrome://"));
  if (!fallback) throw new Error("No controllable browser tab found");
  return fallback;
}

async function assertTabAllowed(tab: chrome.tabs.Tab): Promise<number> {
  if (tab.id === undefined) {
    throw new Error("Target tab does not have a valid tabId");
  }
  const check = isUrlAllowed(tab.url, guardConfig);
  if (!check.allowed) {
    throw new Error(check.reason || "Tab URL blocked by guard config");
  }
  return tab.id;
}

/**
 * 向目标 Tab 的 Content Script 发送消息；若该 Tab 是在插件安装前打开的，自动动态注入 content.js 再重试。
 */
async function sendContentMessage<T = any>(tabId: number, type: string, payload?: unknown): Promise<T> {
  const trySend = () =>
    new Promise<T>((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("Empty response from content script"));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || "Content script execution error"));
          return;
        }
        resolve(response.result as T);
      });
    });

  try {
    return await trySend();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Receiving end does not exist") ||
      msg.includes("Could not establish connection") ||
      msg.includes("Empty response") ||
      msg.includes("Unknown content script action")
    ) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      return await trySend();
    }
    throw err;
  }
}

/**
 * 将标签页归入专属后台 Tab Group（如 "AGY Agent"），避免干扰用户当前前台工作区
 */
async function assignToAgentTabGroup(tabId: number, windowId?: number): Promise<number> {
  const groups = await chrome.tabGroups.query({
    title: guardConfig.agentTabGroupTitle,
    ...(windowId !== undefined ? { windowId } : {})
  });
  const existingGroupId = groups[0]?.id;
  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    ...(existingGroupId !== undefined ? { groupId: existingGroupId } : {})
  });
  if (existingGroupId === undefined) {
    await chrome.tabGroups.update(groupId, {
      title: guardConfig.agentTabGroupTitle,
      color: guardConfig.agentTabGroupColor,
      collapsed: false
    });
  }
  return groupId;
}

async function waitForTabComplete(tabId: number, timeoutMs = 12000): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * 统一处理来自 Native Host（MCP / CLI）或扩展面板的 RPC 指令
 */
async function handleRpcRequest(req: RpcRequest): Promise<RpcResponse> {
  await loadGuardConfig();

  // 元信息与配置管理命令不受 enabled 开关拦截
  if (req.method === "bridge.ping") {
    return {
      id: req.id,
      ok: true,
      result: {
        pong: true,
        extensionId: chrome.runtime.id,
        enabled: guardConfig.enabled,
        developerMode: guardConfig.developerMode,
        timestamp: Date.now()
      }
    };
  }

  if (req.method === "bridge.status") {
    const tabs = await chrome.tabs.query({});
    return {
      id: req.id,
      ok: true,
      result: {
        extensionId: chrome.runtime.id,
        nativeConnected,
        guardConfig,
        openTabCount: tabs.length,
        attachedDebuggerTabs: Array.from(tabTelemetry.entries())
          .filter(([, s]) => s.attached)
          .map(([id]) => id),
        auditLogs: auditLogs.slice(0, 20)
      }
    };
  }

  if (req.method === "bridge.reload") {
    setTimeout(() => {
      chrome.runtime.reload();
    }, 80);
    return {
      id: req.id,
      ok: true,
      result: { reloading: true }
    };
  }

  if (req.method === "guard.getConfig") {
    return { id: req.id, ok: true, result: guardConfig };
  }

  if (req.method === "guard.updateConfig") {
    const updated = await saveGuardConfig((req.params || {}) as Partial<ExtensionGuardConfig>);
    recordAudit(req.method, `Updated guard config (enabled=${updated.enabled}, dev=${updated.developerMode})`, "ok");
    return { id: req.id, ok: true, result: updated };
  }

  // 检查总开关
  if (!guardConfig.enabled) {
    recordAudit(req.method, "Blocked because extension master switch is OFF", "blocked");
    return {
      id: req.id,
      ok: false,
      error: {
        code: "EXTENSION_DISABLED",
        message: "Browser control is currently turned off in the AgentBridge extension toggle."
      }
    };
  }

  const params = (req.params || {}) as Record<string, any>;

  try {
    switch (req.method) {
      case "tabs.list": {
        const tabs = await chrome.tabs.query({});
        const summaries: TabSummary[] = tabs
          .filter((t) => t.id !== undefined)
          .map((t) => ({
            id: t.id!,
            windowId: t.windowId,
            groupId: t.groupId,
            index: t.index,
            title: t.title || "",
            url: t.url || "",
            active: t.active,
            pinned: t.pinned,
            status: t.status,
            audible: t.audible,
            debuggerAttached: tabTelemetry.get(t.id!)?.attached ?? false
          }));
        recordAudit(req.method, `Listed ${summaries.length} open tabs`, "ok");
        return { id: req.id, ok: true, result: { tabs: summaries } };
      }

      case "tabs.open": {
        const url = String(params.url || "about:blank");
        const check = isUrlAllowed(url, guardConfig);
        if (!check.allowed) {
          recordAudit(req.method, check.reason || "Blocked URL", "blocked");
          return {
            id: req.id,
            ok: false,
            error: { code: "DOMAIN_BLOCKED", message: check.reason || "URL blocked" }
          };
        }

        const active = Boolean(params.active ?? true);
        const useTabGroup = params.inAgentGroup !== false;
        const created = await chrome.tabs.create({ url, active });
        if (created.id === undefined) {
          throw new Error("Failed to create tab");
        }

        let groupId = created.groupId;
        if (useTabGroup) {
          try {
            groupId = await assignToAgentTabGroup(created.id, created.windowId);
          } catch {
            // 某些特殊窗口类型不支持 tabGroups 时降级
          }
        }

        if (params.waitForLoad !== false) {
          await waitForTabComplete(created.id);
        }

        if (guardConfig.developerMode && params.attachDebugger !== false && url.startsWith("http")) {
          await ensureDebuggerAttached(created.id, true).catch(() => {});
        }

        if (url.startsWith("http")) {
          await sendContentMessage(created.id, "ab:showStage", {
            label: "已接管此标签页"
          }).catch(() => {});
        }

        const refreshed = await chrome.tabs.get(created.id);
        recordAudit(req.method, `Opened ${url} in group (${groupId})`, "ok", created.id);
        return {
          id: req.id,
          ok: true,
          result: {
            tabId: created.id,
            groupId,
            title: refreshed.title || "",
            url: refreshed.url || url,
            active: refreshed.active
          }
        };
      }

      case "tabs.read": {
        // 支持同时读取单个或多个 Tab（对应 ChatGPT @Chrome 跨标签对比阅读能力）
        const tabIds: number[] = Array.isArray(params.tabIds)
          ? params.tabIds.map(Number)
          : [await assertTabAllowed(await resolveTargetTab(params.tabId))];

        const results = [];
        for (const tid of tabIds) {
          const tab = await chrome.tabs.get(tid);
          await assertTabAllowed(tab);
          const doc = await sendContentMessage(tid, "ab:readDocument", {
            maxChars: params.maxChars ?? 16000
          });
          results.push({
            tabId: tid,
            title: doc.title || tab.title,
            url: doc.url || tab.url,
            selection: doc.selection,
            markdown: doc.markdown
          });
        }
        recordAudit(req.method, `Read markdown context from ${results.length} tab(s)`, "ok", tabIds[0]);
        return { id: req.id, ok: true, result: { documents: results } };
      }

      case "tabs.group": {
        const tabIds: number[] = Array.isArray(params.tabIds) ? params.tabIds.map(Number) : [];
        if (tabIds.length === 0) {
          throw new Error("tabIds array is required for tabs.group");
        }
        const groupId = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(groupId, {
          title: String(params.title || guardConfig.agentTabGroupTitle),
          color: params.color || guardConfig.agentTabGroupColor,
          collapsed: Boolean(params.collapsed ?? false)
        });
        recordAudit(req.method, `Grouped ${tabIds.length} tabs into "${params.title || guardConfig.agentTabGroupTitle}"`, "ok");
        return { id: req.id, ok: true, result: { groupId, tabIds } };
      }

      case "tabs.activate": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        await chrome.tabs.update(tabId, { active: true });
        if (tab.windowId !== undefined) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        recordAudit(req.method, `Activated tab #${tabId}`, "ok", tabId);
        return { id: req.id, ok: true, result: { tabId, active: true } };
      }

      case "tabs.close": {
        const tabIds: number[] = Array.isArray(params.tabIds)
          ? params.tabIds.map(Number)
          : [Number(params.tabId)];
        await chrome.tabs.remove(tabIds);
        recordAudit(req.method, `Closed tab(s): ${tabIds.join(", ")}`, "ok");
        return { id: req.id, ok: true, result: { closedTabIds: tabIds } };
      }

      case "tabs.navigate": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const action = params.action as "url" | "back" | "forward" | "reload" | undefined;

        if (action === "back") {
          await chrome.tabs.goBack(tabId);
        } else if (action === "forward") {
          await chrome.tabs.goForward(tabId);
        } else if (action === "reload") {
          await chrome.tabs.reload(tabId);
        } else {
          const nextUrl = String(params.url || "");
          const check = isUrlAllowed(nextUrl, guardConfig);
          if (!check.allowed) {
            recordAudit(req.method, check.reason || "Blocked URL", "blocked", tabId);
            return {
              id: req.id,
              ok: false,
              error: { code: "DOMAIN_BLOCKED", message: check.reason || "URL blocked" }
            };
          }
          await chrome.tabs.update(tabId, { url: nextUrl });
        }

        if (params.waitForLoad !== false) {
          await waitForTabComplete(tabId);
        }
        const updated = await chrome.tabs.get(tabId);
        if (updated.url?.startsWith("http")) {
          await sendContentMessage(tabId, "ab:showStage", {
            label: "页面加载完成"
          }).catch(() => {});
        }
        recordAudit(req.method, `Navigated tab #${tabId} -> ${updated.url}`, "ok", tabId);
        return {
          id: req.id,
          ok: true,
          result: { tabId, title: updated.title || "", url: updated.url || "" }
        };
      }

      case "dom.snapshot": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const rawSnapshot = await sendContentMessage<Omit<PageSnapshotResult, "tabId">>(
          tabId,
          "ab:snapshot",
          {
            highlight: Boolean(params.highlight ?? false),
            viewportOnly: Boolean(params.viewportOnly ?? false),
            maxElements: Number(params.maxElements ?? 250)
          }
        );
        const snapshot: PageSnapshotResult = { tabId, ...rawSnapshot };
        recordAudit(
          req.method,
          `Captured snapshot on tab #${tabId} (${snapshot.elements.length} interactive elements)`,
          "ok",
          tabId
        );
        return { id: req.id, ok: true, result: snapshot };
      }

      case "dom.clearHighlights": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        await sendContentMessage(tabId, "ab:clearHighlights", {
          hideStage: Boolean(params.hideStage ?? false)
        });
        return { id: req.id, ok: true, result: { tabId, cleared: true } };
      }

      case "dom.moveCursor": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const moveRes = await sendContentMessage<{ x: number; y: number; name?: string }>(
          tabId,
          "ab:moveCursor",
          {
            ref: params.ref,
            selector: params.selector,
            x: params.x,
            y: params.y,
            label: params.label,
            clickRipple: Boolean(params.clickRipple ?? false)
          }
        );
        if (guardConfig.developerMode) {
          try {
            await ensureDebuggerAttached(tabId, true);
            await sendCdp(tabId, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: moveRes.x,
              y: moveRes.y,
              button: "none"
            });
          } catch {}
        }
        recordAudit(
          req.method,
          `Moved virtual cursor to (${moveRes.x}, ${moveRes.y})${moveRes.name ? ` ["${moveRes.name}"]` : ""}`,
          "ok",
          tabId
        );
        return { id: req.id, ok: true, result: { tabId, ...moveRes } };
      }

      case "dom.click": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const targetInfo = await sendContentMessage<{
          x: number;
          y: number;
          tagName: string;
          role: string;
          name: string;
          isSensitiveSubmit: boolean;
          disabled: boolean;
        }>(tabId, "ab:prepareTarget", {
          ref: params.ref,
          selector: params.selector,
          skipClickRipple: true
        });

        // 敏感提交动作护栏：若开启了 confirmBeforeSubmit 且调用方未显式传 confirmed=true，挂起并提示确认
        if (guardConfig.confirmBeforeSubmit && targetInfo.isSensitiveSubmit && !params.confirmed) {
          recordAudit(
            req.method,
            `Paused before sensitive submit action on "${targetInfo.name}" (${params.ref || params.selector})`,
            "blocked",
            tabId
          );
          return {
            id: req.id,
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED",
              message: `Safety guardrail: Target "${targetInfo.name}" (<${targetInfo.tagName}>) is a sensitive submit/send/delete action. Ask the user for confirmation first, then re-invoke dom.click with confirmed: true.`,
              details: targetInfo
            }
          };
        }

        // 播放页面内点击雷达波纹动画
        await sendContentMessage(tabId, "ab:triggerRipple", {
          x: targetInfo.x,
          y: targetInfo.y
        }).catch(() => {});

        if (guardConfig.developerMode) {
          try {
            await ensureDebuggerAttached(tabId, true);
            const { x, y } = targetInfo;
            await sendCdp(tabId, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
              button: "none"
            });
            await sendCdp(tabId, "Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              clickCount: 1
            });
            await sendCdp(tabId, "Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 1
            });
          } catch {
            await sendContentMessage(tabId, "ab:syntheticClick", {
              ref: params.ref,
              selector: params.selector
            });
          }
        } else {
          await sendContentMessage(tabId, "ab:syntheticClick", {
            ref: params.ref,
            selector: params.selector
          });
        }

        recordAudit(
          req.method,
          `Clicked ${params.ref || params.selector} ("${targetInfo.name}") at (${targetInfo.x}, ${targetInfo.y})`,
          "ok",
          tabId
        );
        return {
          id: req.id,
          ok: true,
          result: {
            tabId,
            clicked: params.ref || params.selector,
            target: targetInfo
          }
        };
      }

      case "dom.fill": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const value = String(params.value ?? "");
        const fillRes = await sendContentMessage(tabId, "ab:fill", {
          ref: params.ref,
          selector: params.selector,
          value,
          clear: params.clear !== false
        });

        if (params.pressEnter) {
          if (guardConfig.developerMode) {
            await ensureDebuggerAttached(tabId, true);
            await sendCdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13
            });
            await sendCdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13
            });
          } else {
            await sendContentMessage(tabId, "ab:pressKey", { key: "Enter" });
          }
        }

        recordAudit(req.method, `Filled ${params.ref || params.selector} with ${value.length} chars`, "ok", tabId);
        return {
          id: req.id,
          ok: true,
          result: { tabId, ref: params.ref, selector: params.selector, ...fillRes }
        };
      }

      case "dom.select": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const selectRes = await sendContentMessage(tabId, "ab:select", {
          ref: params.ref,
          selector: params.selector,
          value: String(params.value ?? "")
        });
        recordAudit(req.method, `Selected "${params.value}" on ${params.ref || params.selector}`, "ok", tabId);
        return { id: req.id, ok: true, result: { tabId, ...selectRes } };
      }

      case "dom.press": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const key = String(params.key || "Enter");
        if (guardConfig.developerMode) {
          await ensureDebuggerAttached(tabId, true);
          await sendCdp(tabId, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code: key,
            text: key.length === 1 ? key : undefined
          });
          await sendCdp(tabId, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code: key
          });
        } else {
          await sendContentMessage(tabId, "ab:pressKey", { key });
        }
        recordAudit(req.method, `Pressed key "${key}" on tab #${tabId}`, "ok", tabId);
        return { id: req.id, ok: true, result: { tabId, key } };
      }

      case "dom.scroll": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const scrollRes = await sendContentMessage(tabId, "ab:scroll", {
          deltaX: params.deltaX ?? 0,
          deltaY: params.deltaY ?? 500
        });
        recordAudit(req.method, `Scrolled tab #${tabId} by (${params.deltaX ?? 0}, ${params.deltaY ?? 500})`, "ok", tabId);
        return { id: req.id, ok: true, result: { tabId, ...scrollRes } };
      }

      case "page.screenshot": {
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const format = params.format === "jpeg" ? "jpeg" : "png";

        if (!guardConfig.developerMode && !params.fullPage && tab.active) {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format,
            ...(format === "jpeg" ? { quality: Number(params.quality ?? 80) } : {})
          });
          const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
          recordAudit(req.method, `Captured visible ${format.toUpperCase()} screenshot of tab #${tabId}`, "ok", tabId);
          return {
            id: req.id,
            ok: true,
            result: { tabId, format, base64Data }
          };
        }

        await ensureDebuggerAttached(tabId, guardConfig.developerMode);
        const screenshot = await sendCdp<{ data: string }>(tabId, "Page.captureScreenshot", {
          format,
          ...(format === "jpeg" ? { quality: Number(params.quality ?? 80) } : {}),
          captureBeyondViewport: Boolean(params.fullPage ?? false)
        });
        recordAudit(req.method, `Captured ${format.toUpperCase()} screenshot of tab #${tabId}`, "ok", tabId);
        return {
          id: req.id,
          ok: true,
          result: {
            tabId,
            format,
            base64Data: screenshot.data
          }
        };
      }

      case "dev.getConsoleLogs": {
        if (!guardConfig.developerMode) {
          throw new Error("Developer Mode (Full CDP access) is disabled in extension settings.");
        }
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        await ensureDebuggerAttached(tabId, true);
        const state = getOrCreateTelemetry(tabId);
        const levelFilter = params.level as string | undefined;
        const logs = levelFilter
          ? state.consoleLogs.filter((l) => l.level === levelFilter)
          : state.consoleLogs;

        if (params.clear) {
          state.consoleLogs = [];
        }
        recordAudit(req.method, `Fetched ${logs.length} console/exception logs from tab #${tabId}`, "ok", tabId);
        return { id: req.id, ok: true, result: { tabId, logs } };
      }

      case "dev.getNetworkRequests": {
        if (!guardConfig.developerMode) {
          throw new Error("Developer Mode (Full CDP access) is disabled in extension settings.");
        }
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        await ensureDebuggerAttached(tabId, true);
        const state = getOrCreateTelemetry(tabId);
        let requests = state.networkOrder
          .map((rid) => state.networkRequests.get(rid)!)
          .filter(Boolean);

        if (params.urlFilter) {
          const sub = String(params.urlFilter).toLowerCase();
          requests = requests.filter((r) => r.url.toLowerCase().includes(sub));
        }
        if (params.onlyErrors) {
          requests = requests.filter((r) => (r.status !== undefined && r.status >= 400) || Boolean(r.errorText));
        }
        if (params.clear) {
          state.networkRequests.clear();
          state.networkOrder = [];
        }
        recordAudit(req.method, `Fetched ${requests.length} network requests from tab #${tabId}`, "ok", tabId);
        return { id: req.id, ok: true, result: { tabId, requests } };
      }

      case "dev.getNetworkResponseBody": {
        if (!guardConfig.developerMode) {
          throw new Error("Developer Mode (Full CDP access) is disabled in extension settings.");
        }
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const requestId = String(params.requestId || "");
        if (!requestId) throw new Error("requestId is required");
        await ensureDebuggerAttached(tabId, true);
        const bodyRes = await sendCdp<{ body: string; base64Encoded: boolean }>(
          tabId,
          "Network.getResponseBody",
          { requestId }
        );
        recordAudit(req.method, `Read response body for requestId ${requestId} on tab #${tabId}`, "ok", tabId);
        return { id: req.id, ok: true, result: { tabId, requestId, ...bodyRes } };
      }

      case "dev.getPerformanceMetrics": {
        if (!guardConfig.developerMode) {
          throw new Error("Developer Mode (Full CDP access) is disabled in extension settings.");
        }
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        await ensureDebuggerAttached(tabId, true);
        const perf = await sendCdp<{ metrics: Array<{ name: string; value: number }> }>(
          tabId,
          "Performance.getMetrics"
        );
        recordAudit(req.method, `Collected performance metrics from tab #${tabId}`, "ok", tabId);
        return { id: req.id, ok: true, result: { tabId, metrics: perf.metrics } };
      }

      case "dev.sendCdpCommand": {
        if (!guardConfig.developerMode) {
          throw new Error("Developer Mode (Full CDP access) is disabled in extension settings.");
        }
        const tab = await resolveTargetTab(params.tabId);
        const tabId = await assertTabAllowed(tab);
        const cdpMethod = String(params.cdpMethod || "");
        if (!cdpMethod) throw new Error("cdpMethod is required");
        await ensureDebuggerAttached(tabId, true);
        const cdpResult = await sendCdp(tabId, cdpMethod, (params.cdpParams as Record<string, unknown>) || {});
        recordAudit(req.method, `Executed raw CDP "${cdpMethod}" on tab #${tabId}`, "ok", tabId);
        return { id: req.id, ok: true, result: { tabId, cdpMethod, response: cdpResult } };
      }

      default:
        return {
          id: req.id,
          ok: false,
          error: {
            code: "UNKNOWN_METHOD",
            message: `Unsupported RPC method: ${req.method}`
          }
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordAudit(req.method, message, "error", params.tabId);
    return {
      id: req.id,
      ok: false,
      error: {
        code: "EXECUTION_ERROR",
        message
      }
    };
  }
}

function connectNativeHost(): void {
  if (nativePort) return;

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    nativeConnected = true;
    lastNativeError = null;
    broadcastUiState();

    // 发送初始握手消息
    port.postMessage({
      type: "extension:hello",
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      timestamp: Date.now()
    });

    port.onMessage.addListener((msg: any) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.id && msg.method) {
        handleRpcRequest(msg as RpcRequest).then((res) => {
          try {
            port.postMessage(res);
          } catch {
            // 忽略断连写入失败
          }
        });
      }
    });

    port.onDisconnect.addListener(() => {
      const errMsg = chrome.runtime.lastError?.message || "Native host disconnected";
      nativePort = null;
      nativeConnected = false;
      lastNativeError = errMsg;
      broadcastUiState();
      chrome.alarms.create(RECONNECT_ALARM_NAME, { delayInMinutes: 0.1 });
    });
  } catch (err) {
    nativePort = null;
    nativeConnected = false;
    lastNativeError = err instanceof Error ? err.message : String(err);
    broadcastUiState();
  }
}

// 面板（Popup / SidePanel）内部通信监听
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("ab-panel:")) {
    return false;
  }

  if (message.type === "ab-panel:getState") {
    loadGuardConfig().then(() => {
      sendResponse({
        ok: true,
        result: {
          extensionId: chrome.runtime.id,
          nativeConnected,
          lastNativeError,
          guardConfig,
          attachedTabs: Array.from(tabTelemetry.entries())
            .filter(([, v]) => v.attached)
            .map(([tabId]) => tabId),
          auditLogs
        }
      });
    });
    return true;
  }

  if (message.type === "ab-panel:reconnectNative") {
    if (nativePort) {
      try {
        nativePort.disconnect();
      } catch {}
      nativePort = null;
    }
    connectNativeHost();
    sendResponse({ ok: true, result: { nativeConnected, lastNativeError } });
    return false;
  }

  if (message.type === "ab-panel:rpc") {
    handleRpcRequest(message.payload as RpcRequest).then(sendResponse);
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM_NAME && !nativeConnected) {
    connectNativeHost();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  loadGuardConfig().then(() => {
    connectNativeHost();
  });
});

chrome.runtime.onStartup.addListener(() => {
  loadGuardConfig().then(() => {
    connectNativeHost();
  });
});

// 模块加载时立即初始化
loadGuardConfig().then(() => {
  connectNativeHost();
});
