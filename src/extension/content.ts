import type { InteractiveElementNode, PageSnapshotResult } from "../shared/protocol.js";

const REF_ATTR = "data-agent-ref";
const REF_ATTR_ALIAS = "data-agent-bridge-ref";
const STAGE_HOST_ID = "__agent_bridge_stage_host__";

/**
 * 内存级快照元素索引：
 * 解决 (1) Shadow DOM 节点 querySelector 无法穿透、(2) React/Vue 动态重渲染导致 DOM 节点替换后报 Element not found
 */
const snapshotElementMap = new Map<string, HTMLElement>();
const snapshotMetaMap = new Map<string, InteractiveElementNode>();

function isPageHidden(): boolean {
  return document.hidden || document.visibilityState !== "visible";
}

const SENSITIVE_SUBMIT_PATTERN =
  /\b(submit|send|pay|purchase|checkout|delete|remove|confirm|publish|transfer|authorize|提交|发送|支付|付款|结算|删除|移除|确认|发布|转账|授权)\b/i;

/**
 * 页面内视觉舞台状态（维护虚拟光标位置、Shadow DOM 节点与动画队列）
 */
interface AgentStageState {
  hostEl: HTMLElement;
  shadow: ShadowRoot;
  glowEl: HTMLElement;
  somLayerEl: HTMLElement;
  targetRingEl: HTMLElement;
  cursorWrapEl: HTMLElement;
  cursorArrowEl: HTMLElement;
  cursorTagEl: HTMLElement;
  hudTextEl: HTMLElement;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
}

let stageState: AgentStageState | null = null;

const STAGE_CSS = `
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  }

  /* 1. 视口四周呼吸流光边框 */
  .ab-viewport-glow {
    position: fixed;
    inset: 0;
    pointer-events: none;
    border: 2.5px solid rgba(59, 130, 246, 0.78);
    box-shadow:
      inset 0 0 28px rgba(37, 99, 235, 0.28),
      inset 0 0 8px rgba(6, 182, 212, 0.35);
    opacity: 0;
    transition: opacity 280ms ease;
    animation: abGlowPulse 3.2s ease-in-out infinite;
  }
  .ab-viewport-glow.active {
    opacity: 1;
  }
  @keyframes abGlowPulse {
    0%, 100% {
      box-shadow:
        inset 0 0 24px rgba(37, 99, 235, 0.24),
        inset 0 0 6px rgba(6, 182, 212, 0.3);
      border-color: rgba(59, 130, 246, 0.72);
    }
    50% {
      box-shadow:
        inset 0 0 42px rgba(37, 99, 235, 0.42),
        inset 0 0 14px rgba(99, 102, 241, 0.45);
      border-color: rgba(99, 102, 241, 0.92);
    }
  }

  /* 2. 目标元素吸附高亮框 */
  .ab-target-ring {
    position: fixed;
    pointer-events: none;
    border: 2px solid #2563eb;
    background: rgba(37, 99, 235, 0.08);
    border-radius: 6px;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18), 0 4px 16px rgba(37, 99, 235, 0.22);
    opacity: 0;
    transition:
      left 220ms cubic-bezier(0.22, 1, 0.36, 1),
      top 220ms cubic-bezier(0.22, 1, 0.36, 1),
      width 220ms cubic-bezier(0.22, 1, 0.36, 1),
      height 220ms cubic-bezier(0.22, 1, 0.36, 1),
      opacity 180ms ease;
  }
  .ab-target-ring.visible {
    opacity: 1;
  }

  /* 3. Set-of-Mark 角标容器 */
  .ab-som-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }

  /* 4. 拟真 AI 虚拟鼠标指针与胶囊标签 */
  .ab-cursor-wrap {
    position: fixed;
    left: 0;
    top: 0;
    pointer-events: none;
    z-index: 10;
    opacity: 0;
    will-change: transform, opacity;
    transition: opacity 200ms ease;
  }
  .ab-cursor-wrap.visible {
    opacity: 1;
  }
  .ab-cursor-arrow {
    width: 26px;
    height: 26px;
    transform-origin: 3px 3px;
    transition: transform 110ms cubic-bezier(0.34, 1.56, 0.64, 1);
    filter: drop-shadow(0 3px 8px rgba(15, 23, 42, 0.38)) drop-shadow(0 0 6px rgba(37, 99, 235, 0.45));
  }
  .ab-cursor-arrow.clicking {
    transform: scale(0.82);
  }
  .ab-cursor-tag {
    position: absolute;
    left: 20px;
    top: 18px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
    color: #f8fafc;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    border: 1px solid rgba(59, 130, 246, 0.55);
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.32), 0 0 10px rgba(37, 99, 235, 0.25);
  }
  .ab-cursor-tag-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #38bdf8;
    box-shadow: 0 0 6px #38bdf8;
  }

  /* 5. 点击波纹与轨迹尾迹粒子 */
  .ab-click-ripple {
    position: fixed;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    margin-top: -7px;
    border-radius: 50%;
    pointer-events: none;
    border: 2.5px solid #3b82f6;
    background: rgba(59, 130, 246, 0.28);
    box-shadow: 0 0 14px rgba(59, 130, 246, 0.65);
    animation: abRippleExpand 560ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .ab-click-ripple.secondary {
    border-color: #38bdf8;
    background: transparent;
    animation-delay: 75ms;
    animation-duration: 640ms;
  }
  @keyframes abRippleExpand {
    0% {
      transform: scale(0.4);
      opacity: 1;
    }
    100% {
      transform: scale(4.2);
      opacity: 0;
    }
  }

  .ab-trail-dot {
    position: fixed;
    width: 7px;
    height: 7px;
    margin-left: -3.5px;
    margin-top: -3.5px;
    border-radius: 50%;
    pointer-events: none;
    background: radial-gradient(circle, rgba(56, 189, 248, 0.85) 0%, rgba(37, 99, 235, 0) 75%);
    animation: abTrailFade 360ms ease-out forwards;
  }
  @keyframes abTrailFade {
    0% {
      transform: scale(1);
      opacity: 0.75;
    }
    100% {
      transform: scale(0.2);
      opacity: 0;
    }
  }

  /* 6. 底部悬浮毛玻璃状态胶囊栏 (HUD) */
  .ab-hud-bar {
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px 7px 14px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.86);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(59, 130, 246, 0.45);
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.35), 0 0 16px rgba(37, 99, 235, 0.22);
    color: #f8fafc;
    font-size: 12px;
    font-weight: 500;
    opacity: 0;
    transition: opacity 220ms ease, transform 220ms ease;
  }
  .ab-hud-bar.active {
    opacity: 1;
  }
  .ab-hud-orb {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #38bdf8;
    box-shadow: 0 0 10px #38bdf8;
    animation: abOrbPulse 1.4s ease-in-out infinite;
  }
  @keyframes abOrbPulse {
    0%, 100% { transform: scale(0.9); opacity: 0.8; }
    50% { transform: scale(1.25); opacity: 1; }
  }
  .ab-hud-text {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ab-hud-btn {
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: rgba(255, 255, 255, 0.1);
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 999px;
    cursor: pointer;
    transition: background 150ms ease;
  }
  .ab-hud-btn:hover {
    background: rgba(239, 68, 68, 0.85);
    border-color: rgba(239, 68, 68, 1);
  }
`;

/**
 * 确保页面内已挂载 Shadow DOM 视觉舞台（含呼吸边框、虚拟鼠标、目标吸附框与底部 HUD）
 */
function ensureAgentStage(): AgentStageState {
  if (stageState && document.documentElement.contains(stageState.hostEl)) {
    return stageState;
  }

  const existing = document.getElementById(STAGE_HOST_ID);
  if (existing) existing.remove();
  const legacyHost = document.getElementById("__agent_bridge_legacy_host__");
  if (legacyHost) legacyHost.remove();

  const hostEl = document.createElement("div");
  hostEl.id = STAGE_HOST_ID;
  const shadow = hostEl.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = STAGE_CSS;

  const glowEl = document.createElement("div");
  glowEl.className = "ab-viewport-glow active";

  const somLayerEl = document.createElement("div");
  somLayerEl.className = "ab-som-layer";

  const targetRingEl = document.createElement("div");
  targetRingEl.className = "ab-target-ring";

  const cursorWrapEl = document.createElement("div");
  cursorWrapEl.className = "ab-cursor-wrap";

  const cursorArrowEl = document.createElement("div");
  cursorArrowEl.className = "ab-cursor-arrow";
  // 高辨识度 AI 矢量光标（蓝黑渐变填充 + 高亮白边）
  cursorArrowEl.innerHTML = `
    <svg viewBox="0 0 28 28" width="26" height="26" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="abCursorGrad" x1="2" y1="2" x2="22" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#3b82f6" />
          <stop offset="55%" stop-color="#1d4ed8" />
          <stop offset="100%" stop-color="#0f172a" />
        </linearGradient>
      </defs>
      <path
        d="M3.5 2.8L23.2 11.4C24.5 11.97 24.42 13.84 23.08 14.3L14.8 17.12L11.58 25.18C11.05 26.5 9.18 26.47 8.7 25.13L1.7 5.02C1.25 3.74 2.26 2.26 3.5 2.8Z"
        fill="url(#abCursorGrad)"
        stroke="#ffffff"
        stroke-width="1.8"
        stroke-linejoin="round"
      />
    </svg>
  `;

  const cursorTagEl = document.createElement("div");
  cursorTagEl.className = "ab-cursor-tag";
  cursorTagEl.innerHTML = `<span class="ab-cursor-tag-dot"></span><span class="ab-tag-label">AgentBridge</span>`;

  cursorWrapEl.appendChild(cursorArrowEl);
  cursorWrapEl.appendChild(cursorTagEl);

  const hudBarEl = document.createElement("div");
  hudBarEl.className = "ab-hud-bar active";
  const hudOrb = document.createElement("span");
  hudOrb.className = "ab-hud-orb";
  const hudTextEl = document.createElement("span");
  hudTextEl.className = "ab-hud-text";
  hudTextEl.textContent = "AgentBridge 正在控制此页面";
  const stopBtn = document.createElement("button");
  stopBtn.className = "ab-hud-btn";
  stopBtn.textContent = "隐藏光标";
  stopBtn.addEventListener("click", () => {
    hideAgentStage();
  });

  hudBarEl.appendChild(hudOrb);
  hudBarEl.appendChild(hudTextEl);
  hudBarEl.appendChild(stopBtn);

  shadow.appendChild(styleEl);
  shadow.appendChild(glowEl);
  shadow.appendChild(somLayerEl);
  shadow.appendChild(targetRingEl);
  shadow.appendChild(cursorWrapEl);
  shadow.appendChild(hudBarEl);

  document.documentElement.appendChild(hostEl);

  // 初始位置设在右上角扩展栏下方，首次激活时会沿大弧线飞入页面中心
  const initX = Math.max(120, Math.round(window.innerWidth - 72));
  const initY = 28;
  cursorWrapEl.style.transform = `translate3d(${initX}px, ${initY}px, 0)`;

  stageState = {
    hostEl,
    shadow,
    glowEl,
    somLayerEl,
    targetRingEl,
    cursorWrapEl,
    cursorArrowEl,
    cursorTagEl,
    hudTextEl,
    cursorX: initX,
    cursorY: initY,
    cursorVisible: false
  };

  return stageState;
}

function setStageActionLabel(cursorLabel: string, hudLabel?: string): void {
  const st = ensureAgentStage();
  st.glowEl.classList.add("active");
  st.cursorWrapEl.classList.add("visible");
  st.cursorVisible = true;

  const labelSpan = st.cursorTagEl.querySelector(".ab-tag-label");
  if (labelSpan) {
    labelSpan.textContent = cursorLabel;
  }
  const hudBar = st.shadow.querySelector(".ab-hud-bar");
  if (hudBar) hudBar.classList.add("active");
  st.hudTextEl.textContent = hudLabel || `AgentBridge · ${cursorLabel}`;
}

function showTargetLockRing(rect: DOMRect | { x: number; y: number; width: number; height: number }): void {
  const st = ensureAgentStage();
  const pad = 4;
  st.targetRingEl.style.left = `${Math.round(rect.x - pad)}px`;
  st.targetRingEl.style.top = `${Math.round(rect.y - pad)}px`;
  st.targetRingEl.style.width = `${Math.round(rect.width + pad * 2)}px`;
  st.targetRingEl.style.height = `${Math.round(rect.height + pad * 2)}px`;
  st.targetRingEl.classList.add("visible");
}

function hideTargetLockRing(): void {
  if (!stageState) return;
  stageState.targetRingEl.classList.remove("visible");
}

function hideAgentStage(): void {
  if (!stageState) return;
  stageState.glowEl.classList.remove("active");
  stageState.cursorWrapEl.classList.remove("visible");
  stageState.targetRingEl.classList.remove("visible");
  const hudBar = stageState.shadow.querySelector(".ab-hud-bar");
  if (hudBar) hudBar.classList.remove("active");
  stageState.somLayerEl.innerHTML = "";
}

function spawnTrailDot(x: number, y: number): void {
  if (!stageState) return;
  const dot = document.createElement("div");
  dot.className = "ab-trail-dot";
  dot.style.left = `${Math.round(x)}px`;
  dot.style.top = `${Math.round(y)}px`;
  stageState.shadow.appendChild(dot);
  setTimeout(() => dot.remove(), 380);
}

function spawnClickRipple(x: number, y: number): void {
  const st = ensureAgentStage();
  st.cursorArrowEl.classList.add("clicking");
  setTimeout(() => st.cursorArrowEl.classList.remove("clicking"), 150);

  const ring1 = document.createElement("div");
  ring1.className = "ab-click-ripple";
  ring1.style.left = `${Math.round(x)}px`;
  ring1.style.top = `${Math.round(y)}px`;

  const ring2 = document.createElement("div");
  ring2.className = "ab-click-ripple secondary";
  ring2.style.left = `${Math.round(x)}px`;
  ring2.style.top = `${Math.round(y)}px`;

  st.shadow.appendChild(ring1);
  st.shadow.appendChild(ring2);
  setTimeout(() => {
    ring1.remove();
    ring2.remove();
  }, 700);
}

/**
 * 驱动虚拟 AI 鼠标沿拟人二次贝塞尔弧线从当前坐标滑行至目标坐标 (targetX, targetY)
 */
async function animateCursorTo(
  rawTargetX: number,
  rawTargetY: number,
  label: string,
  hudMessage?: string
): Promise<void> {
  const st = ensureAgentStage();
  setStageActionLabel(label, hudMessage);

  const targetX = Math.max(12, Math.min(window.innerWidth - 28, Math.round(rawTargetX)));
  const targetY = Math.max(12, Math.min(window.innerHeight - 28, Math.round(rawTargetY)));
  const startX = st.cursorX;
  const startY = st.cursorY;
  const dx = targetX - startX;
  const dy = targetY - startY;
  const distance = Math.hypot(dx, dy);

  // 后台标签页 (document.hidden) 下 Chrome 会挂起 requestAnimationFrame，直接 0ms 瞬移返回，杜绝后台操控超时
  if (isPageHidden() || distance < 4) {
    st.cursorX = targetX;
    st.cursorY = targetY;
    st.cursorWrapEl.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
    return;
  }

  // 根据距离自适应动画时长 (380ms ~ 720ms)，让前台肉眼清晰看到拟人加减速弧线滑行
  const durationMs = Math.min(720, Math.max(380, Math.round(distance * 0.85)));
  const midX = (startX + targetX) / 2;
  const midY = (startY + targetY) / 2;
  const bend = Math.min(85, distance * 0.18);
  const normX = -dy / distance;
  const normY = dx / distance;
  const ctrlX = midX + normX * bend;
  const ctrlY = midY + normY * bend;

  return new Promise<void>((resolve) => {
    const startTime = performance.now();
    let lastTrailTime = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      st.cursorX = targetX;
      st.cursorY = targetY;
      st.cursorWrapEl.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
      resolve();
    };

    // 硬超时守卫：若动画中途用户切走标签页导致 rAF 被 Chrome 挂起，按时强制完成，绝不阻塞 RPC
    const safetyTimer = setTimeout(finish, durationMs + 80);

    const step = (now: number) => {
      if (settled) return;
      if (isPageHidden()) {
        finish();
        return;
      }
      const elapsed = now - startTime;
      const rawT = Math.min(1, elapsed / durationMs);
      // easeOutCubic + easeInOut 混合平滑曲线
      const t = 1 - Math.pow(1 - rawT, 3);

      const invT = 1 - t;
      const curX = invT * invT * startX + 2 * invT * t * ctrlX + t * t * targetX;
      const curY = invT * invT * startY + 2 * invT * t * ctrlY + t * t * targetY;

      st.cursorX = curX;
      st.cursorY = curY;
      st.cursorWrapEl.style.transform = `translate3d(${curX.toFixed(1)}px, ${curY.toFixed(1)}px, 0)`;

      if (now - lastTrailTime > 28 && rawT < 0.92) {
        lastTrailTime = now;
        spawnTrailDot(curX, curY);
      }

      if (rawT < 1) {
        requestAnimationFrame(step);
      } else {
        finish();
      }
    };

    requestAnimationFrame(step);
  });
}

function isElementVisible(el: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean {
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") < 0.05) {
    return false;
  }
  if (rect.width < 2 || rect.height < 2) {
    return false;
  }
  // 过滤通过 translateX 移出屏幕左右边界外的隐藏抽屉节点
  if (rect.right <= 4 || rect.left >= window.innerWidth - 4) {
    return false;
  }
  return true;
}

function inferRole(el: HTMLElement): string {
  const explicitRole = el.getAttribute("role");
  if (explicitRole) return explicitRole;
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }
  if (el.isContentEditable) return "textbox";
  return tag;
}

function isInteractiveElement(el: HTMLElement, style: CSSStyleDeclaration): boolean {
  const tag = el.tagName.toLowerCase();
  if (["button", "select", "textarea", "summary"].includes(tag)) return true;
  if (tag === "a" && (el.hasAttribute("href") || style.cursor === "pointer")) return true;
  if (tag === "input" && (el as HTMLInputElement).type !== "hidden") return true;
  if (el.isContentEditable) return true;

  const role = el.getAttribute("role");
  if (
    role &&
    [
      "button",
      "link",
      "tab",
      "menuitem",
      "option",
      "checkbox",
      "radio",
      "switch",
      "combobox",
      "textbox",
      "searchbox"
    ].includes(role)
  ) {
    return true;
  }

  if (el.hasAttribute("onclick") || (el.tabIndex >= 0 && style.cursor === "pointer")) {
    return true;
  }
  return false;
}

function computeAccessibleName(el: HTMLElement): string {
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelText = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() || "")
      .filter(Boolean)
      .join(" ");
    if (labelText) return labelText;
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.id) {
      const associatedLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (associatedLabel?.textContent?.trim()) {
        return associatedLabel.textContent.trim();
      }
    }
    const parentLabel = el.closest("label");
    if (parentLabel?.textContent?.trim()) {
      return parentLabel.textContent.trim();
    }
    if ("placeholder" in el && el.placeholder?.trim()) {
      return el.placeholder.trim();
    }
  }

  const title = el.getAttribute("title")?.trim();
  if (title) return title;

  const alt = el.getAttribute("alt")?.trim();
  if (alt) return alt;

  return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function detectSensitiveSubmit(el: HTMLElement, role: string, name: string, text: string): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" && (el as HTMLInputElement).type === "submit") {
    return true;
  }
  if (tag === "button" && (el as HTMLButtonElement).type === "submit") {
    return true;
  }
  if (role === "button" || role === "link" || tag === "button" || tag === "a") {
    const combined = `${name} ${text} ${el.getAttribute("name") || ""} ${el.id || ""}`;
    if (SENSITIVE_SUBMIT_PATTERN.test(combined)) {
      return true;
    }
  }
  return false;
}

export function extractMarkdownDocument(maxChars = 16000): {
  title: string;
  url: string;
  selection: string;
  markdown: string;
} {
  const selection = window.getSelection()?.toString()?.trim() || "";
  const lines: string[] = [];

  const root = document.querySelector("main, article, [role='main']") || document.body;
  if (!root) {
    return { title: document.title, url: location.href, selection, markdown: "" };
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as HTMLElement;
      if (el.id === STAGE_HOST_ID) return NodeFilter.FILTER_REJECT;
      const tag = el.tagName?.toLowerCase();
      if (["script", "style", "noscript", "svg", "path", "nav", "footer"].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let currentNode: Node | null = walker.currentNode;
  while (currentNode) {
    const el = currentNode as HTMLElement;
    const tag = el.tagName?.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1], 10);
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text) lines.push(`${"#".repeat(level)} ${text}`);
    } else if (tag === "p" || tag === "li" || tag === "blockquote" || tag === "pre") {
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text && text.length > 1) {
        lines.push(tag === "li" ? `- ${text}` : text);
      }
    }
    if (lines.join("\n").length >= maxChars) break;
    currentNode = walker.nextNode();
  }

  let markdown = lines.join("\n\n").slice(0, maxChars);
  if (!markdown) {
    markdown = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
  }

  return {
    title: document.title,
    url: location.href,
    selection,
    markdown
  };
}

export function clearSetOfMarkOverlay(): void {
  if (!stageState) return;
  stageState.somLayerEl.innerHTML = "";
  hideTargetLockRing();
}

function renderSetOfMarkOverlay(elements: InteractiveElementNode[]): void {
  const st = ensureAgentStage();
  st.somLayerEl.innerHTML = "";

  for (const item of elements) {
    const { x, y, width, height } = item.rect;
    if (y + height < 0 || y > window.innerHeight || x + width < 0 || x > window.innerWidth) {
      continue;
    }
    const box = document.createElement("div");
    const borderColor = item.isSensitiveSubmit ? "#ef4444" : "#2563eb";
    box.style.cssText = [
      "position: fixed",
      `left: ${Math.max(0, x)}px`,
      `top: ${Math.max(0, y)}px`,
      `width: ${width}px`,
      `height: ${height}px`,
      `border: 1.5px solid ${borderColor}`,
      "border-radius: 4px",
      "box-sizing: border-box",
      "pointer-events: none"
    ].join(";");

    const badge = document.createElement("span");
    badge.textContent = item.ref;
    badge.style.cssText = [
      "position: absolute",
      "top: -16px",
      "left: -1.5px",
      `background: ${borderColor}`,
      "color: #ffffff",
      "font-family: ui-monospace, SFMono-Regular, Menlo, monospace",
      "font-size: 10px",
      "font-weight: 700",
      "line-height: 14px",
      "padding: 0 4px",
      "border-radius: 3px",
      "white-space: nowrap",
      "box-shadow: 0 1px 2px rgba(0,0,0,0.25)"
    ].join(";");

    box.appendChild(badge);
    st.somLayerEl.appendChild(box);
  }
}

export function collectInteractiveSnapshot(options?: {
  highlight?: boolean;
  viewportOnly?: boolean;
  maxElements?: number;
}): Omit<PageSnapshotResult, "tabId"> {
  const highlight = options?.highlight ?? false;
  const viewportOnly = options?.viewportOnly ?? false;
  const maxElements = options?.maxElements ?? 250;

  ensureAgentStage();
  setStageActionLabel("扫描页面元素", `AgentBridge 正在感知页面结构 (${document.title || location.hostname})`);

  snapshotElementMap.clear();
  snapshotMetaMap.clear();
  document
    .querySelectorAll(`[${REF_ATTR}], [${REF_ATTR_ALIAS}]`)
    .forEach((el) => {
      el.removeAttribute(REF_ATTR);
      el.removeAttribute(REF_ATTR_ALIAS);
    });

  const elements: InteractiveElementNode[] = [];
  let counter = 0;

  const visitRoot = (root: Document | ShadowRoot | Element) => {
    const allNodes = root.querySelectorAll("*");
    for (let i = 0; i < allNodes.length; i++) {
      if (elements.length >= maxElements) break;
      const el = allNodes[i] as HTMLElement;
      if (el.id === STAGE_HOST_ID || el.closest(`#${STAGE_HOST_ID}`)) continue;

      if (el.shadowRoot && el.id !== STAGE_HOST_ID) {
        visitRoot(el.shadowRoot);
      }

      const style = window.getComputedStyle(el);
      if (!isInteractiveElement(el, style)) continue;

      const rect = el.getBoundingClientRect();
      if (!isElementVisible(el, style, rect)) continue;

      if (viewportOnly) {
        if (
          rect.bottom < 0 ||
          rect.top > window.innerHeight ||
          rect.right < 0 ||
          rect.left > window.innerWidth
        ) {
          continue;
        }
      }

      counter += 1;
      const ref = `e${counter}`;
      // 无论 highlight 是 true 还是 false，始终写入双属性并注册到内存 Map
      el.setAttribute(REF_ATTR, ref);
      el.setAttribute(REF_ATTR_ALIAS, ref);
      snapshotElementMap.set(ref, el);

      const role = inferRole(el);
      const name = computeAccessibleName(el);
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
      const tagName = el.tagName.toLowerCase();

      const node: InteractiveElementNode = {
        ref,
        tagName,
        role,
        name: name || text,
        text,
        disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true",
        isSensitiveSubmit: detectSensitiveSubmit(el, role, name, text),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };

      if (el instanceof HTMLInputElement) {
        node.type = el.type;
        if (el.type === "checkbox" || el.type === "radio") {
          node.checked = el.checked;
        } else if (el.type !== "password") {
          node.value = el.value.slice(0, 120);
        }
        if (el.placeholder) node.placeholder = el.placeholder;
      } else if (el instanceof HTMLTextAreaElement) {
        node.value = el.value.slice(0, 120);
        if (el.placeholder) node.placeholder = el.placeholder;
      } else if (el instanceof HTMLSelectElement) {
        node.value = el.value;
      } else if (el instanceof HTMLAnchorElement && el.href) {
        node.href = el.href;
      }

      snapshotMetaMap.set(ref, node);
      elements.push(node);
    }
  };

  visitRoot(document);

  if (highlight) {
    renderSetOfMarkOverlay(elements);
  } else if (stageState) {
    stageState.somLayerEl.innerHTML = "";
  }

  const docExcerpt = extractMarkdownDocument(4000);

  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight
    },
    markdownExcerpt: docExcerpt.markdown,
    elements,
    highlighted: highlight
  };
}

function queryDeepSelector(selector: string, root: Document | ShadowRoot | Element = document): HTMLElement | null {
  const direct = root.querySelector(selector) as HTMLElement | null;
  if (direct) return direct;
  const all = root.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    if (el.id === STAGE_HOST_ID) continue;
    if (el.shadowRoot) {
      const found = queryDeepSelector(selector, el.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

function findElementByRefOrSelector(ref?: string, selector?: string): HTMLElement {
  if (ref) {
    // 1. 内存 Map O(1) 直连命中
    const cached = snapshotElementMap.get(ref);
    if (cached && cached.isConnected) {
      return cached;
    }

    // 2. 穿透 ShadowRoot 检索 data-agent-ref / data-agent-bridge-ref 属性
    const escaped = CSS.escape(ref);
    const byAttr = queryDeepSelector(`[${REF_ATTR}="${escaped}"], [${REF_ATTR_ALIAS}="${escaped}"]`);
    if (byAttr) {
      snapshotElementMap.set(ref, byAttr);
      return byAttr;
    }

    // 3. 若 SPA (React/Vue) 在 snapshot 后重渲染替换了 DOM 节点，使用快照元数据自愈匹配
    const meta = snapshotMetaMap.get(ref);
    if (meta) {
      const candidates = Array.from(document.querySelectorAll(meta.tagName)) as HTMLElement[];
      let bestMatch: HTMLElement | null = null;
      let bestScore = -1;

      for (const cand of candidates) {
        const style = window.getComputedStyle(cand);
        const rect = cand.getBoundingClientRect();
        if (!isElementVisible(cand, style, rect)) continue;

        const candName = computeAccessibleName(cand);
        const candText = (cand.innerText || cand.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
        let score = 0;
        if (meta.name && (candName === meta.name || candText === meta.name)) score += 100;
        else if (meta.text && candText === meta.text) score += 80;
        else if (meta.name && (candName.includes(meta.name) || meta.name.includes(candName))) score += 40;

        const dist = Math.hypot(rect.left - meta.rect.x, rect.top - meta.rect.y);
        if (dist < 80) score += Math.max(0, 50 - dist * 0.5);

        if (score > bestScore && score >= 45) {
          bestScore = score;
          bestMatch = cand;
        }
      }

      if (bestMatch) {
        bestMatch.setAttribute(REF_ATTR, ref);
        bestMatch.setAttribute(REF_ATTR_ALIAS, ref);
        snapshotElementMap.set(ref, bestMatch);
        return bestMatch;
      }
    }
  }

  if (selector) {
    const bySelector = queryDeepSelector(selector);
    if (bySelector) return bySelector;
  }
  throw new Error(`Element not found for ${ref ? `ref="${ref}"` : `selector="${selector}"`}. Run dom.snapshot first.`);
}

/**
 * 准备并动画滑行虚拟鼠标至目标元素（后台 Tab 自动 0ms 瞬发，不等待动画或平滑滚动）
 */
async function prepareAndGlideToElement(params: {
  ref?: string;
  selector?: string;
  actionType?: "click" | "hover" | "fill" | "select";
  skipClickRipple?: boolean;
}) {
  const el = findElementByRefOrSelector(params.ref, params.selector);
  const hidden = isPageHidden();

  if (hidden) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  } else {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await new Promise((r) => setTimeout(r, 90));
  }

  const rect = el.getBoundingClientRect();
  const role = inferRole(el);
  const name = computeAccessibleName(el);
  const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const displayName = (name || text || params.ref || params.selector || el.tagName.toLowerCase()).slice(0, 28);
  const isSensitiveSubmit = detectSensitiveSubmit(el, role, name, text);

  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);

  showTargetLockRing(rect);
  const actionVerb =
    params.actionType === "fill"
      ? `输入 · ${displayName}`
      : params.actionType === "hover"
        ? `悬停 · ${displayName}`
        : `点击 · ${displayName}`;

  await animateCursorTo(x, y, actionVerb, `AgentBridge 正在${actionVerb}`);

  if (!hidden && !params.skipClickRipple && params.actionType !== "hover") {
    spawnClickRipple(x, y);
  }

  return {
    x,
    y,
    tagName: el.tagName.toLowerCase(),
    role,
    name: name || text,
    isSensitiveSubmit,
    disabled: (el as HTMLButtonElement).disabled === true
  };
}

/**
 * 拟真滑行至输入框 + 点击波纹 + 填入内容
 */
async function fillElementValueAnimated(params: {
  ref?: string;
  selector?: string;
  value: string;
  clear?: boolean;
}) {
  const el = findElementByRefOrSelector(params.ref, params.selector);
  await prepareAndGlideToElement({
    ref: params.ref,
    selector: params.selector,
    actionType: "fill"
  });

  el.focus();
  const preview = params.value.length > 20 ? `${params.value.slice(0, 20)}...` : params.value;
  setStageActionLabel(`输入 "${preview}"`, `AgentBridge 正在输入 "${preview}"`);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto =
      el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const nextValue = params.clear === false ? `${el.value}${params.value}` : params.value;
    if (nativeSetter) {
      nativeSetter.call(el, nextValue);
    } else {
      el.value = nextValue;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: params.value, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { tagName: el.tagName.toLowerCase(), value: el.value };
  }

  if (el.isContentEditable) {
    if (params.clear !== false) {
      el.innerHTML = "";
    }
    el.textContent = params.clear === false ? `${el.textContent || ""}${params.value}` : params.value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: params.value, inputType: "insertText" }));
    return { tagName: el.tagName.toLowerCase(), value: el.textContent || "" };
  }

  throw new Error(`Element <${el.tagName.toLowerCase()}> is not a fillable input or contenteditable`);
}

async function selectElementOptionAnimated(params: { ref?: string; selector?: string; value: string }) {
  const el = findElementByRefOrSelector(params.ref, params.selector);
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`Element <${el.tagName.toLowerCase()}> is not a <select> element`);
  }
  await prepareAndGlideToElement({
    ref: params.ref,
    selector: params.selector,
    actionType: "select"
  });

  const option = Array.from(el.options).find(
    (opt) => opt.value === params.value || opt.text.trim() === params.value
  );
  if (!option) {
    throw new Error(`Option "${params.value}" not found in <select>`);
  }
  el.value = option.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { selectedValue: el.value, selectedText: option.text.trim() };
}

function fallbackSyntheticClick(params: { ref?: string; selector?: string }) {
  const el = findElementByRefOrSelector(params.ref, params.selector);
  const rect = el.getBoundingClientRect();
  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: 1
  };

  el.dispatchEvent(new PointerEvent("pointerover", eventInit));
  el.dispatchEvent(new MouseEvent("mouseover", eventInit));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...eventInit, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...eventInit, bubbles: false }));
  el.dispatchEvent(new PointerEvent("pointermove", eventInit));
  el.dispatchEvent(new MouseEvent("mousemove", eventInit));
  el.dispatchEvent(new PointerEvent("pointerdown", eventInit));
  el.dispatchEvent(new MouseEvent("mousedown", eventInit));
  el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", eventInit));
  el.dispatchEvent(new MouseEvent("mouseup", eventInit));
  el.click();
  return { clicked: true, clientX, clientY };
}

function dispatchDomKeyPress(params: { key: string }) {
  const key = params.key || "Enter";
  const target = (document.activeElement as HTMLElement) || document.body;
  const keyInit: KeyboardEventInit = {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    composed: true
  };
  target.dispatchEvent(new KeyboardEvent("keydown", keyInit));
  target.dispatchEvent(new KeyboardEvent("keypress", keyInit));
  target.dispatchEvent(new KeyboardEvent("keyup", keyInit));
  if (key === "Enter" && target instanceof HTMLInputElement && target.form) {
    target.form.requestSubmit?.();
  }
  return { key, targetTag: target.tagName.toLowerCase() };
}

const globalWindow = window as unknown as {
  __AGENT_BRIDGE_LISTENER__?: (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ) => boolean;
};

if (globalWindow.__AGENT_BRIDGE_LISTENER__) {
  try {
    chrome.runtime.onMessage.removeListener(globalWindow.__AGENT_BRIDGE_LISTENER__);
  } catch {}
}

const messageListener = (
  message: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) => {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("ab:")) {
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case "ab:ping":
          sendResponse({ ok: true, result: { ready: true, url: location.href } });
          return;

        case "ab:showStage": {
          ensureAgentStage();
          const label = message.payload?.label || "已接管页面";
          await animateCursorTo(
            message.payload?.x ?? Math.round(window.innerWidth * 0.52),
            message.payload?.y ?? Math.round(window.innerHeight * 0.42),
            label,
            `AgentBridge · ${label}`
          );
          sendResponse({ ok: true, result: { stageActive: true } });
          return;
        }

        case "ab:moveCursor": {
          if (message.payload?.ref || message.payload?.selector) {
            const res = await prepareAndGlideToElement({
              ref: message.payload.ref,
              selector: message.payload.selector,
              actionType: "hover",
              skipClickRipple: true
            });
            sendResponse({ ok: true, result: res });
            return;
          }
          const x = Number(message.payload?.x ?? window.innerWidth / 2);
          const y = Number(message.payload?.y ?? window.innerHeight / 2);
          await animateCursorTo(x, y, message.payload?.label || `移动 (${x}, ${y})`);
          if (message.payload?.clickRipple) {
            spawnClickRipple(x, y);
          }
          sendResponse({ ok: true, result: { x, y } });
          return;
        }

        case "ab:triggerRipple": {
          const st = ensureAgentStage();
          spawnClickRipple(message.payload?.x ?? st.cursorX, message.payload?.y ?? st.cursorY);
          sendResponse({ ok: true, result: { rippled: true } });
          return;
        }

        case "ab:readDocument":
          setStageActionLabel("读取页面上下文", "AgentBridge 正在读取当前页面内容");
          sendResponse({ ok: true, result: extractMarkdownDocument(message.payload?.maxChars) });
          return;

        case "ab:snapshot":
          sendResponse({ ok: true, result: collectInteractiveSnapshot(message.payload) });
          return;

        case "ab:clearHighlights":
          clearSetOfMarkOverlay();
          if (message.payload?.hideStage) {
            hideAgentStage();
          }
          sendResponse({ ok: true, result: { cleared: true } });
          return;

        case "ab:prepareTarget": {
          const targetRes = await prepareAndGlideToElement({
            ref: message.payload?.ref,
            selector: message.payload?.selector,
            actionType: "click",
            skipClickRipple: Boolean(message.payload?.skipClickRipple)
          });
          sendResponse({ ok: true, result: targetRes });
          return;
        }

        case "ab:syntheticClick":
          sendResponse({ ok: true, result: fallbackSyntheticClick(message.payload) });
          return;

        case "ab:pressKey":
          sendResponse({ ok: true, result: dispatchDomKeyPress(message.payload) });
          return;

        case "ab:fill": {
          const fillRes = await fillElementValueAnimated(message.payload);
          sendResponse({ ok: true, result: fillRes });
          return;
        }

        case "ab:select": {
          const selRes = await selectElementOptionAnimated(message.payload);
          sendResponse({ ok: true, result: selRes });
          return;
        }

        case "ab:scroll": {
          const dx = Number(message.payload?.deltaX ?? 0);
          const dy = Number(message.payload?.deltaY ?? 500);
          setStageActionLabel(dy >= 0 ? "向下滚动" : "向上滚动", "AgentBridge 正在滚动浏览页面");
          if (isPageHidden()) {
            window.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior });
          } else {
            window.scrollBy({ left: dx, top: dy, behavior: "smooth" });
            await new Promise((r) => setTimeout(r, 180));
          }
          sendResponse({
            ok: true,
            result: {
              scrollX: Math.round(window.scrollX),
              scrollY: Math.round(window.scrollY)
            }
          });
          return;
        }

        default:
          sendResponse({ ok: false, error: `Unknown content script action: ${message.type}` });
          return;
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  })();

  return true;
};

globalWindow.__AGENT_BRIDGE_LISTENER__ = messageListener;
chrome.runtime.onMessage.addListener(messageListener);
