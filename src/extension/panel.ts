import type { AuditLogItem, ExtensionGuardConfig } from "../shared/protocol.js";

const toggleEnabled = document.getElementById("toggleEnabled") as HTMLInputElement;
const toggleStealthMode = document.getElementById("toggleStealthMode") as HTMLInputElement;
const toggleDevMode = document.getElementById("toggleDevMode") as HTMLInputElement;
const toggleConfirmSubmit = document.getElementById("toggleConfirmSubmit") as HTMLInputElement;
const masterStatusLabel = document.getElementById("masterStatusLabel") as HTMLElement;
const connBadge = document.getElementById("connBadge") as HTMLElement;
const connText = document.getElementById("connText") as HTMLElement;
const extIdCode = document.getElementById("extIdCode") as HTMLElement;
const nativeErrorBox = document.getElementById("nativeErrorBox") as HTMLElement;
const attachedCount = document.getElementById("attachedCount") as HTMLElement;
const auditList = document.getElementById("auditList") as HTMLElement;
const btnReconnect = document.getElementById("btnReconnect") as HTMLButtonElement;

function escapeHtml(raw: string): string {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderState(state: {
  extensionId?: string;
  nativeConnected: boolean;
  lastNativeError: string | null;
  guardConfig: ExtensionGuardConfig;
  attachedTabs: number[];
  auditLogs: AuditLogItem[];
}): void {
  if (state.extensionId) {
    extIdCode.textContent = state.extensionId;
  } else {
    extIdCode.textContent = chrome.runtime.id;
  }

  toggleEnabled.checked = state.guardConfig.enabled;
  masterStatusLabel.textContent = state.guardConfig.enabled ? "已开启" : "关闭";
  if (toggleStealthMode) {
    toggleStealthMode.checked = state.guardConfig.stealthMode !== false;
  }
  toggleDevMode.checked = state.guardConfig.developerMode;
  toggleConfirmSubmit.checked = state.guardConfig.confirmBeforeSubmit;

  if (state.nativeConnected) {
    connBadge.className = "badge online";
    connText.textContent = "Native 已连接";
    nativeErrorBox.style.display = "none";
  } else {
    connBadge.className = "badge offline";
    connText.textContent = "未连接宿主";
    if (state.lastNativeError) {
      nativeErrorBox.style.display = "block";
      nativeErrorBox.textContent = `提示: ${state.lastNativeError}（请运行 npx agent-bridge install）`;
    }
  }

  attachedCount.textContent = `${state.attachedTabs.length} 个调试标签`;

  if (!state.auditLogs || state.auditLogs.length === 0) {
    auditList.innerHTML = `<div class="empty">暂无 Agent 操作记录</div>`;
    return;
  }

  auditList.innerHTML = state.auditLogs
    .slice(0, 25)
    .map((item) => {
      const timeStr = new Date(item.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
      const safeStatus = ["ok", "blocked", "error"].includes(item.status) ? item.status : "ok";
      const safeMethod = escapeHtml(item.method);
      const safeTab = item.tabId ? ` (#${Number(item.tabId)})` : "";
      const safeSummary = escapeHtml(item.summary);
      return `
        <div class="audit-item ${safeStatus}">
          <div class="audit-item-top">
            <span>${safeMethod}${safeTab}</span>
            <span>${escapeHtml(timeStr)}</span>
          </div>
          <div>${safeSummary}</div>
        </div>
      `;
    })
    .join("");
}

function updateConfig(partial: Partial<ExtensionGuardConfig>): void {
  chrome.runtime.sendMessage(
    {
      type: "ab-panel:rpc",
      payload: {
        id: `panel-${Date.now()}`,
        method: "guard.updateConfig",
        params: partial
      }
    },
    () => {
      refreshState();
    }
  );
}

function refreshState(): void {
  chrome.runtime.sendMessage({ type: "ab-panel:getState" }, (res) => {
    if (res?.ok && res.result) {
      renderState(res.result);
    }
  });
}

toggleEnabled.addEventListener("change", () => {
  updateConfig({ enabled: toggleEnabled.checked });
});

toggleStealthMode?.addEventListener("change", () => {
  updateConfig({ stealthMode: toggleStealthMode.checked });
});

toggleDevMode.addEventListener("change", () => {
  updateConfig({ developerMode: toggleDevMode.checked });
});

toggleConfirmSubmit.addEventListener("change", () => {
  updateConfig({ confirmBeforeSubmit: toggleConfirmSubmit.checked });
});

btnReconnect.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "ab-panel:reconnectNative" }, () => {
    setTimeout(refreshState, 200);
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "ab-ui:state" && message.payload) {
    renderState(message.payload);
  }
});

refreshState();
