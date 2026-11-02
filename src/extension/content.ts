import type { InteractiveElementNode, PageSnapshotResult } from "../shared/protocol.js";

/**
 * 纯 Isolated World 内存级快照元素索引：
 * 彻底不在宿主页面 DOM 节点上写入任何 data-agent-* 属性，也不暴露任何固定 ID，
 * 使网页 Main World 的 MutationObserver 与 querySelector 100% 无法探测到扩展痕迹。
 */
const snapshotElementMap = new Map<string, HTMLElement>();
const snapshotMetaMap = new Map<string, InteractiveElementNode>();
const snapshotOffsetMap = new Map<string, { x: number; y: number }>();

function isPageHidden(): boolean {
  return document.hidden || document.visibilityState !== "visible";
}

const SENSITIVE_SUBMIT_PATTERN =
  /\b(submit|send|pay|purchase|checkout|delete|remove|confirm|publish|transfer|authorize|提交|发送|支付|付款|结算|删除|移除|确认|发布|转账|授权)\b/i;

/**
 * 页面内视觉舞台状态（维护虚拟光标位置、Closed Shadow DOM 节点与动画队列）
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

function isStageNode(el: Element): boolean {
  return Boolean(stageState && (el === stageState.hostEl || stageState.hostEl.contains(el)));
}

/**
 * 确保页面内已挂载 Closed Shadow DOM 视觉舞台（无任何 ID/Class 特征，网页 JS 无法访问 shadowRoot）
 */
function ensureAgentStage(): AgentStageState {
  if (stageState && document.documentElement.contains(stageState.hostEl)) {
    return stageState;
  }

  // 清理可能残留的旧版节点
  const legacy1 = document.getElementById("__agent_bridge_stage_host__");
  if (legacy1) legacy1.remove();
  const legacy2 = document.getElementById("__agent_bridge_legacy_host__");
  if (legacy2) legacy2.remove();

  // 创建无任何 id/class/attribute 特征的宿主节点，并使用 mode: "closed" 彻底屏蔽网页脚本探测
  const hostEl = document.createElement("div");
  const shadow = hostEl.attachShadow({ mode: "closed" });

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

function setStageActionLabel(cursorLabel: string, hudLabel?: string, forceMount = true): void {
  if (!forceMount && !stageState) return;
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

function showTargetLockRing(rect: { x: number; y: number; width: number; height: number }): void {
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
  setStageActionLabel(label, hudMessage, true);

  const targetX = Math.max(8, Math.min(window.innerWidth - 16, Math.round(rawTargetX)));
  const targetY = Math.max(8, Math.min(window.innerHeight - 16, Math.round(rawTargetY)));
  const startX = st.cursorX;
  const startY = st.cursorY;
  const dx = targetX - startX;
  const dy = targetY - startY;
  const distance = Math.hypot(dx, dy);

  if (isPageHidden() || distance < 4) {
    st.cursorX = targetX;
    st.cursorY = targetY;
    st.cursorWrapEl.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
    return;
  }

  // 自适应滑行时长 (220ms ~ 520ms)，兼顾流畅视觉与高频操作速度
  const durationMs = Math.min(520, Math.max(220, Math.round(distance * 0.65)));
  const midX = (startX + targetX) / 2;
  const midY = (startY + targetY) / 2;
  const bend = Math.min(72, distance * 0.16);
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

    const safetyTimer = setTimeout(finish, durationMs + 60);

    const step = (now: number) => {
      if (settled) return;
      if (isPageHidden()) {
        finish();
        return;
      }
      const elapsed = now - startTime;
      const rawT = Math.min(1, elapsed / durationMs);
      const t = 1 - Math.pow(1 - rawT, 3);

      const invT = 1 - t;
      const curX = invT * invT * startX + 2 * invT * t * ctrlX + t * t * targetX;
      const curY = invT * invT * startY + 2 * invT * t * ctrlY + t * t * targetY;

      st.cursorX = curX;
      st.cursorY = curY;
      st.cursorWrapEl.style.transform = `translate3d(${curX.toFixed(1)}px, ${curY.toFixed(1)}px, 0)`;

      if (now - lastTrailTime > 32 && rawT < 0.92) {
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

/**
 * 在目标元素安全盒内生成带近似正态分布微偏移（Jitter）的点击坐标，消除每次点击绝对几何中心的机器特征
 */
function computeNaturalTargetPoint(rect: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
} {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  if (rect.width <= 10 || rect.height <= 10) {
    return { x: Math.round(centerX), y: Math.round(centerY) };
  }
  // 双随机数均值近似三角/高斯分布，限制在中心 [-0.18, +0.18] 宽高范围内
  const randX = (Math.random() + Math.random() - 1) * 0.18 * rect.width;
  const randY = (Math.random() + Math.random() - 1) * 0.18 * rect.height;
  return {
    x: Math.round(centerX + randX),
    y: Math.round(centerY + randY)
  };
}

function isElementVisible(el: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean {
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.pointerEvents === "none" ||
    parseFloat(style.opacity || "1") < 0.05 ||
    parseFloat(style.fontSize || "12") === 0
  ) {
    return false;
  }
  if (rect.width < 2 || rect.height < 2) {
    return false;
  }
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
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "file") return "file";
    return "textbox";
  }
  if (el.isContentEditable) return "textbox";
  return tag;
}

const INTERACTIVE_TAGS = new Set(["button", "select", "textarea", "summary", "a", "input"]);
const INTERACTIVE_ROLES = new Set([
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
]);

/**
 * 第一阶段零开销标签/属性初筛：避免对页面内成千上万个普通布局节点无差别调用 getComputedStyle
 */
function passesFastInteractivePrecheck(el: HTMLElement): "definite" | "maybe_pointer" | "no" {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    return (el as HTMLInputElement).type === "hidden" ? "no" : "definite";
  }
  if (INTERACTIVE_TAGS.has(tag)) {
    if (tag === "a" && !el.hasAttribute("href")) return "maybe_pointer";
    return "definite";
  }
  if (el.isContentEditable) return "definite";

  const role = el.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role)) return "definite";

  if (el.hasAttribute("onclick") || el.hasAttribute("@click") || el.hasAttribute("ng-click")) {
    return "definite";
  }

  if (el.tabIndex >= 0) return "maybe_pointer";

  // 仅对子元素较少（常见自定义 div/span 按钮）的节点进一步检查 cursor: pointer
  if (el.childElementCount <= 3 && (tag === "div" || tag === "span" || tag === "li" || tag === "label")) {
    return "maybe_pointer";
  }
  return "no";
}

function computeAccessibleName(el: HTMLElement): string {
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  const ownerDoc = el.ownerDocument || document;
  if (labelledBy) {
    const labelText = labelledBy
      .split(/\s+/)
      .map((id) => ownerDoc.getElementById(id)?.textContent?.trim() || "")
      .filter(Boolean)
      .join(" ");
    if (labelText) return labelText;
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.id) {
      const associatedLabel = ownerDoc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
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

/**
 * 检测在输入框内按 Enter 键是否会触发敏感表单提交
 */
function isEnterKeySensitiveOnElement(el: HTMLElement | null): { isSensitive: boolean; formName: string } {
  if (!el) return { isSensitive: false, formName: "" };
  const form = el.closest("form");
  if (!form) {
    const name = computeAccessibleName(el);
    return {
      isSensitive: SENSITIVE_SUBMIT_PATTERN.test(name),
      formName: name || el.tagName.toLowerCase()
    };
  }
  const submitBtn = form.querySelector(
    'button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])'
  ) as HTMLElement | null;
  if (submitBtn) {
    const btnName = computeAccessibleName(submitBtn);
    const btnText = (submitBtn.innerText || submitBtn.textContent || "").trim();
    return {
      isSensitive: true,
      formName: btnName || btnText || form.getAttribute("name") || "form"
    };
  }
  return { isSensitive: true, formName: form.getAttribute("name") || "form" };
}

function tableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return "";
  const matrix: string[][] = [];
  let maxCols = 0;

  for (const tr of rows) {
    const cells = Array.from(tr.querySelectorAll("th, td")).map((cell) =>
      ((cell as HTMLElement).innerText || cell.textContent || "")
        .replace(/\s+/g, " ")
        .replace(/\|/g, "\\|")
        .trim()
    );
    if (cells.some(Boolean)) {
      matrix.push(cells);
      if (cells.length > maxCols) maxCols = cells.length;
    }
  }

  if (matrix.length === 0 || maxCols === 0) return "";
  const normalizeRow = (r: string[]) => {
    const padded = [...r];
    while (padded.length < maxCols) padded.push("");
    return `| ${padded.join(" | ")} |`;
  };

  const header = normalizeRow(matrix[0]);
  const separator = `| ${Array(maxCols).fill("---").join(" | ")} |`;
  const body = matrix.slice(1).map(normalizeRow);
  return [header, separator, ...body].join("\n");
}

export function extractMarkdownDocument(maxChars = 16000): {
  title: string;
  url: string;
  selection: string;
  markdown: string;
} {
  const selection = window.getSelection()?.toString()?.trim() || "";
  const lines: string[] = [];
  let totalLen = 0;

  const root = document.querySelector("main, article, [role='main']") || document.body;
  if (!root) {
    return { title: document.title, url: location.href, selection, markdown: "" };
  }

  const consumedContainers = new WeakSet<Node>();

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as HTMLElement;
      if (isStageNode(el)) return NodeFilter.FILTER_REJECT;
      let parent = el.parentElement;
      while (parent && parent !== root) {
        if (consumedContainers.has(parent)) return NodeFilter.FILTER_REJECT;
        parent = parent.parentElement;
      }
      const tag = el.tagName?.toLowerCase();
      if (["script", "style", "noscript", "svg", "path", "nav", "footer"].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        parseFloat(style.opacity || "1") < 0.05 ||
        parseFloat(style.fontSize || "12") === 0
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let currentNode: Node | null = walker.currentNode;
  while (currentNode) {
    const el = currentNode as HTMLElement;
    const tag = el.tagName?.toLowerCase();
    let chunk = "";

    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1], 10);
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text) chunk = `${"#".repeat(level)} ${text}`;
      consumedContainers.add(el);
    } else if (tag === "table" && el instanceof HTMLTableElement) {
      chunk = tableToMarkdown(el);
      consumedContainers.add(el);
    } else if (tag === "pre") {
      const codeText = (el.innerText || el.textContent || "").trim();
      if (codeText) chunk = `\`\`\`\n${codeText}\n\`\`\``;
      consumedContainers.add(el);
    } else if (tag === "li") {
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text && text.length > 1) chunk = `- ${text}`;
      consumedContainers.add(el);
    } else if (tag === "blockquote") {
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text) chunk = `> ${text}`;
      consumedContainers.add(el);
    } else if (tag === "p") {
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text && text.length > 1) chunk = text;
      consumedContainers.add(el);
    }

    if (chunk) {
      lines.push(chunk);
      totalLen += chunk.length + 2;
      if (totalLen >= maxChars) break;
    }
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

  // 若未开启 highlight，保持静默，不主动创建视觉舞台 DOM
  setStageActionLabel("扫描页面元素", `AgentBridge 正在感知页面结构 (${document.title || location.hostname})`, highlight);

  snapshotElementMap.clear();
  snapshotMetaMap.clear();
  snapshotOffsetMap.clear();

  const elements: InteractiveElementNode[] = [];
  let counter = 0;

  const visitRoot = (root: Document | ShadowRoot | Element, offsetX = 0, offsetY = 0) => {
    const allNodes = root.querySelectorAll("*");
    for (let i = 0; i < allNodes.length; i++) {
      if (elements.length >= maxElements) break;
      const el = allNodes[i] as HTMLElement;
      if (isStageNode(el)) continue;

      if (el.shadowRoot) {
        visitRoot(el.shadowRoot, offsetX, offsetY);
      }

      // 穿透同源 iframe 并叠加视口坐标偏移
      if (el.tagName === "IFRAME") {
        try {
          const iframeEl = el as HTMLIFrameElement;
          const iframeDoc = iframeEl.contentDocument;
          if (iframeDoc) {
            const iframeRect = iframeEl.getBoundingClientRect();
            if (iframeRect.width >= 10 && iframeRect.height >= 10) {
              visitRoot(iframeDoc, offsetX + iframeRect.left, offsetY + iframeRect.top);
            }
          }
        } catch {
          // 跨域 iframe 由浏览器同源策略隔离，安全忽略
        }
        continue;
      }

      const precheck = passesFastInteractivePrecheck(el);
      if (precheck === "no") continue;

      const view = el.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(el);
      if (precheck === "maybe_pointer" && style.cursor !== "pointer") {
        continue;
      }

      const rawRect = el.getBoundingClientRect();
      if (!isElementVisible(el, style, rawRect)) continue;

      const absLeft = rawRect.left + offsetX;
      const absTop = rawRect.top + offsetY;
      const absRight = rawRect.right + offsetX;
      const absBottom = rawRect.bottom + offsetY;

      if (viewportOnly) {
        if (
          absBottom < 0 ||
          absTop > window.innerHeight ||
          absRight < 0 ||
          absLeft > window.innerWidth
        ) {
          continue;
        }
      }

      counter += 1;
      const ref = `e${counter}`;
      snapshotElementMap.set(ref, el);
      snapshotOffsetMap.set(ref, { x: offsetX, y: offsetY });

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
          x: Math.round(absLeft),
          y: Math.round(absTop),
          width: Math.round(rawRect.width),
          height: Math.round(rawRect.height)
        }
      };

      if (el instanceof HTMLInputElement || tagName === "input") {
        const inputEl = el as HTMLInputElement;
        node.type = inputEl.type;
        if (inputEl.type === "checkbox" || inputEl.type === "radio") {
          node.checked = inputEl.checked;
        } else if (inputEl.type !== "password") {
          node.value = (inputEl.value || "").slice(0, 120);
        }
        if (inputEl.placeholder) node.placeholder = inputEl.placeholder;
      } else if (el instanceof HTMLTextAreaElement || tagName === "textarea") {
        const areaEl = el as HTMLTextAreaElement;
        node.value = (areaEl.value || "").slice(0, 120);
        if (areaEl.placeholder) node.placeholder = areaEl.placeholder;
      } else if (el instanceof HTMLSelectElement || tagName === "select") {
        node.value = (el as HTMLSelectElement).value;
      } else if (tagName === "a" && (el as HTMLAnchorElement).href) {
        node.href = (el as HTMLAnchorElement).href;
      }

      snapshotMetaMap.set(ref, node);
      elements.push(node);
    }
  };

  visitRoot(document, 0, 0);

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

function queryDeepSelector(
  selector: string,
  root: Document | ShadowRoot | Element = document,
  offsetX = 0,
  offsetY = 0
): { el: HTMLElement; offsetX: number; offsetY: number } | null {
  try {
    const direct = root.querySelector(selector) as HTMLElement | null;
    if (direct && !isStageNode(direct)) {
      return { el: direct, offsetX, offsetY };
    }
  } catch {
    return null;
  }

  const all = root.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    if (isStageNode(el)) continue;
    if (el.shadowRoot) {
      const found = queryDeepSelector(selector, el.shadowRoot, offsetX, offsetY);
      if (found) return found;
    }
    if (el.tagName === "IFRAME") {
      try {
        const iframeEl = el as HTMLIFrameElement;
        if (iframeEl.contentDocument) {
          const r = iframeEl.getBoundingClientRect();
          const found = queryDeepSelector(selector, iframeEl.contentDocument, offsetX + r.left, offsetY + r.top);
          if (found) return found;
        }
      } catch {}
    }
  }
  return null;
}

function resolveElementWithOffset(ref?: string, selector?: string): {
  el: HTMLElement;
  offsetX: number;
  offsetY: number;
} {
  if (ref) {
    // 1. 内存 Map O(1) 直连命中
    const cached = snapshotElementMap.get(ref);
    if (cached && cached.isConnected) {
      const off = snapshotOffsetMap.get(ref) || { x: 0, y: 0 };
      return { el: cached, offsetX: off.x, offsetY: off.y };
    }

    // 2. 若 SPA (React/Vue) 在 snapshot 后重渲染替换了 DOM 节点，使用快照元数据自愈匹配
    const meta = snapshotMetaMap.get(ref);
    if (meta) {
      const candidates = Array.from(document.querySelectorAll(meta.tagName)) as HTMLElement[];
      let bestMatch: HTMLElement | null = null;
      let bestScore = -1;

      for (const cand of candidates) {
        if (isStageNode(cand)) continue;
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
        snapshotElementMap.set(ref, bestMatch);
        snapshotOffsetMap.set(ref, { x: 0, y: 0 });
        return { el: bestMatch, offsetX: 0, offsetY: 0 };
      }
    }
  }

  if (selector) {
    const bySelector = queryDeepSelector(selector);
    if (bySelector) return bySelector;
  }
  throw new Error(`Element not found for ${ref ? `ref="${ref}"` : `selector="${selector}"`}. Run dom.snapshot first.`);
}

function findElementByRefOrSelector(ref?: string, selector?: string): HTMLElement {
  return resolveElementWithOffset(ref, selector).el;
}

/**
 * 准备并动画滑行虚拟鼠标至目标元素（含拟人微抖动坐标 Jitter，后台 Tab 自动 0ms 瞬发）
 */
async function prepareAndGlideToElement(params: {
  ref?: string;
  selector?: string;
  actionType?: "click" | "hover" | "fill" | "select";
  skipClickRipple?: boolean;
}) {
  const { el, offsetX, offsetY } = resolveElementWithOffset(params.ref, params.selector);
  const hidden = isPageHidden();

  if (hidden) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  } else {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await new Promise((r) => setTimeout(r, 75));
  }

  const rawRect = el.getBoundingClientRect();
  const rect = {
    x: rawRect.left + offsetX,
    y: rawRect.top + offsetY,
    width: rawRect.width,
    height: rawRect.height
  };
  const role = inferRole(el);
  const name = computeAccessibleName(el);
  const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const displayName = (name || text || params.ref || params.selector || el.tagName.toLowerCase()).slice(0, 28);
  const isSensitiveSubmit = detectSensitiveSubmit(el, role, name, text);

  const { x, y } = computeNaturalTargetPoint(rect);

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
 * 拟真滑行至输入框 + 点击波纹 + 填入内容（自动脱敏 password 字段，并派发完整按键与输入事件链）
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
  const isPassword = el.tagName.toLowerCase() === "input" && (el as HTMLInputElement).type === "password";
  const maskedValue = isPassword
    ? "••••••••"
    : params.value.length > 20
      ? `${params.value.slice(0, 20)}...`
      : params.value;
  setStageActionLabel(`输入 "${maskedValue}"`, `AgentBridge 正在输入 "${maskedValue}"`, true);

  const lastChar = params.value.slice(-1) || "a";
  const keyOpts: KeyboardEventInit = {
    key: lastChar,
    code: `Key${lastChar.toUpperCase()}`,
    bubbles: true,
    cancelable: true,
    composed: true
  };

  el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
  el.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      data: params.value,
      inputType: "insertText"
    })
  );

  const tagName = el.tagName.toLowerCase();
  const enterCheck = isEnterKeySensitiveOnElement(el);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || tagName === "input" || tagName === "textarea") {
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
    const view = el.ownerDocument?.defaultView || window;
    const proto =
      tagName === "input" ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const nextValue = params.clear === false ? `${inputEl.value}${params.value}` : params.value;
    if (nativeSetter) {
      nativeSetter.call(inputEl, nextValue);
    } else {
      inputEl.value = nextValue;
    }
    inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: params.value, inputType: "insertText" }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
    return {
      tagName,
      value: isPassword ? "***" : inputEl.value,
      isSensitiveEnter: enterCheck.isSensitive,
      formName: enterCheck.formName
    };
  }

  if (el.isContentEditable) {
    if (params.clear !== false) {
      el.innerHTML = "";
    }
    el.textContent = params.clear === false ? `${el.textContent || ""}${params.value}` : params.value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: params.value, inputType: "insertText" }));
    el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
    return {
      tagName,
      value: el.textContent || "",
      isSensitiveEnter: enterCheck.isSensitive,
      formName: enterCheck.formName
    };
  }

  throw new Error(`Element <${tagName}> is not a fillable input or contenteditable`);
}

async function selectElementOptionAnimated(params: { ref?: string; selector?: string; value: string }) {
  const el = findElementByRefOrSelector(params.ref, params.selector) as HTMLSelectElement;
  if (el.tagName.toLowerCase() !== "select") {
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

/**
 * 派发包含完整物理屏幕坐标 (screenX/screenY) 与自然按压延时的点击序列
 */
async function performNaturalSyntheticClick(params: { ref?: string; selector?: string; x?: number; y?: number }) {
  const { el, offsetX, offsetY } = resolveElementWithOffset(params.ref, params.selector);
  const rawRect = el.getBoundingClientRect();
  const jittered = computeNaturalTargetPoint({
    x: rawRect.left,
    y: rawRect.top,
    width: rawRect.width,
    height: rawRect.height
  });
  const clientX = params.x !== undefined ? params.x - offsetX : jittered.x;
  const clientY = params.y !== undefined ? params.y - offsetY : jittered.y;
  const screenX = Math.round(clientX + offsetX + (window.screenX || 0));
  const screenY = Math.round(clientY + offsetY + (window.screenY || 0) + (window.outerHeight - window.innerHeight));

  const view = el.ownerDocument?.defaultView || window;
  const baseInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    clientX,
    clientY,
    screenX,
    screenY,
    button: 0,
    buttons: 1,
    detail: 1
  };

  el.dispatchEvent(new PointerEvent("pointerover", baseInit));
  el.dispatchEvent(new MouseEvent("mouseover", baseInit));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...baseInit, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...baseInit, bubbles: false }));
  el.dispatchEvent(new PointerEvent("pointermove", baseInit));
  el.dispatchEvent(new MouseEvent("mousemove", baseInit));
  el.dispatchEvent(new PointerEvent("pointerdown", baseInit));
  el.dispatchEvent(new MouseEvent("mousedown", baseInit));
  el.focus();

  if (!isPageHidden()) {
    const pressDelay = 28 + Math.floor(Math.random() * 34);
    await new Promise((r) => setTimeout(r, pressDelay));
  }

  const releaseInit: MouseEventInit = { ...baseInit, buttons: 0 };
  el.dispatchEvent(new PointerEvent("pointerup", releaseInit));
  el.dispatchEvent(new MouseEvent("mouseup", releaseInit));
  el.click();
  return { clicked: true, clientX: clientX + offsetX, clientY: clientY + offsetY, screenX, screenY };
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

/**
 * 查找页面内可滚动容器（支持显式指定 ref/selector，或从当前光标/视口中心自动探测局部 overflow 容器）
 */
function findScrollableContainer(
  ref?: string,
  selector?: string,
  deltaX = 0,
  deltaY = 500
): HTMLElement | null {
  if (ref || selector) {
    return findElementByRefOrSelector(ref, selector);
  }

  const isScrollable = (node: HTMLElement): boolean => {
    const style = window.getComputedStyle(node);
    if (Math.abs(deltaY) >= Math.abs(deltaX)) {
      const canY = ["auto", "scroll", "overlay"].includes(style.overflowY);
      return canY && node.scrollHeight > node.clientHeight + 4;
    }
    const canX = ["auto", "scroll", "overlay"].includes(style.overflowX);
    return canX && node.scrollWidth > node.clientWidth + 4;
  };

  // 1. 从当前虚拟鼠标位置或视口中心下的元素向上查找可滚动祖先
  const probeX = stageState?.cursorVisible ? stageState.cursorX : Math.round(window.innerWidth / 2);
  const probeY = stageState?.cursorVisible ? stageState.cursorY : Math.round(window.innerHeight / 2);
  let curr = document.elementFromPoint(probeX, probeY) as HTMLElement | null;
  while (curr && curr !== document.body && curr !== document.documentElement) {
    if (!isStageNode(curr) && isScrollable(curr)) {
      return curr;
    }
    curr = curr.parentElement;
  }

  // 2. 若文档根节点自身不可滚动（如飞书、Notion 等全屏应用），查找页面内面积最大的可滚动容器
  const docScrollable = document.documentElement.scrollHeight > window.innerHeight + 8;
  if (!docScrollable) {
    const candidates = Array.from(document.querySelectorAll("main, section, div, ul, article")) as HTMLElement[];
    let best: HTMLElement | null = null;
    let bestArea = 0;
    for (const c of candidates) {
      if (isStageNode(c)) continue;
      if (isScrollable(c)) {
        const r = c.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea && r.width > 120 && r.height > 120) {
          bestArea = area;
          best = c;
        }
      }
    }
    if (best) return best;
  }

  return null;
}

/**
 * 智能等待条件满足（支持 selector 出现/消失、文本包含、或 DOM 变更静默）
 */
async function waitForPageCondition(params: {
  selector?: string;
  text?: string;
  state?: "visible" | "hidden" | "attached" | "detached" | "domSettled";
  timeoutMs?: number;
  settleMs?: number;
}): Promise<{ matched: boolean; elapsedMs: number; url: string; title: string }> {
  const timeoutMs = Math.min(20000, Math.max(100, Number(params.timeoutMs ?? 5000)));
  const state = params.state || (params.selector || params.text ? "visible" : "domSettled");
  const startTime = performance.now();

  if (state === "domSettled") {
    const quietWindowMs = Math.min(1000, Math.max(80, Number(params.settleMs ?? 180)));
    return new Promise((resolve) => {
      let quietTimer: ReturnType<typeof setTimeout>;
      const done = (matched: boolean) => {
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        observer.disconnect();
        resolve({
          matched,
          elapsedMs: Math.round(performance.now() - startTime),
          url: location.href,
          title: document.title
        });
      };

      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => done(true), quietWindowMs);
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true
      });

      quietTimer = setTimeout(() => done(true), quietWindowMs);
      const maxTimer = setTimeout(() => done(true), timeoutMs);
    });
  }

  const checkNow = (): boolean => {
    if (params.selector) {
      const found = queryDeepSelector(params.selector);
      if (state === "detached") return !found;
      if (state === "attached") return Boolean(found);
      if (!found) return state === "hidden";
      const style = window.getComputedStyle(found.el);
      const rect = found.el.getBoundingClientRect();
      const vis = isElementVisible(found.el, style, rect);
      return state === "hidden" ? !vis : vis;
    }
    if (params.text) {
      const bodyText = document.body?.innerText || document.documentElement?.textContent || "";
      const hasText = bodyText.includes(params.text);
      return state === "hidden" || state === "detached" ? !hasText : hasText;
    }
    return true;
  };

  if (checkNow()) {
    return {
      matched: true,
      elapsedMs: Math.round(performance.now() - startTime),
      url: location.href,
      title: document.title
    };
  }

  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (checkNow()) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve({
          matched: true,
          elapsedMs: Math.round(performance.now() - startTime),
          url: location.href,
          title: document.title
        });
      }
    }, 60);

    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve({
        matched: checkNow(),
        elapsedMs: Math.round(performance.now() - startTime),
        url: location.href,
        title: document.title
      });
    }, timeoutMs);
  });
}

// 使用模块级闭包维护 Listener，避免在 window 对象上挂载任何可读字符串属性
let activeMessageListener: ((
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) => boolean) | null = null;

if (activeMessageListener) {
  try {
    chrome.runtime.onMessage.removeListener(activeMessageListener);
  } catch {}
}

activeMessageListener = (
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
          // 只读模式下不强制创建舞台 DOM
          setStageActionLabel("读取页面上下文", "AgentBridge 正在读取当前页面内容", false);
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

        case "ab:syntheticClick": {
          const clickRes = await performNaturalSyntheticClick(message.payload || {});
          sendResponse({ ok: true, result: clickRes });
          return;
        }

        case "ab:checkEnterSensitivity": {
          const active = (document.activeElement as HTMLElement) || null;
          sendResponse({ ok: true, result: isEnterKeySensitiveOnElement(active) });
          return;
        }

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
          const container = findScrollableContainer(
            message.payload?.ref,
            message.payload?.selector,
            dx,
            dy
          );
          setStageActionLabel(dy >= 0 ? "向下滚动" : "向上滚动", "AgentBridge 正在滚动浏览页面", false);
          const behavior: ScrollBehavior = isPageHidden() ? ("instant" as ScrollBehavior) : "smooth";

          if (container) {
            container.scrollBy({ left: dx, top: dy, behavior });
            if (!isPageHidden()) await new Promise((r) => setTimeout(r, 140));
            sendResponse({
              ok: true,
              result: {
                scrolledContainer: container.tagName.toLowerCase(),
                scrollX: Math.round(container.scrollLeft),
                scrollY: Math.round(container.scrollTop)
              }
            });
          } else {
            window.scrollBy({ left: dx, top: dy, behavior });
            if (!isPageHidden()) await new Promise((r) => setTimeout(r, 140));
            sendResponse({
              ok: true,
              result: {
                scrolledContainer: "window",
                scrollX: Math.round(window.scrollX),
                scrollY: Math.round(window.scrollY)
              }
            });
          }
          return;
        }

        case "ab:waitFor": {
          const waitRes = await waitForPageCondition(message.payload || {});
          sendResponse({ ok: true, result: waitRes });
          return;
        }

        case "ab:prepareFileUpload": {
          const el = findElementByRefOrSelector(message.payload?.ref, message.payload?.selector);
          if (el.tagName.toLowerCase() !== "input" || (el as HTMLInputElement).type !== "file") {
            throw new Error(`Target element <${el.tagName.toLowerCase()}> is not an <input type="file">`);
          }
          // 临时生成一个瞬时唯一属性供 CDP DOM.querySelector 定位，定位后立即清除
          const token = `ab-up-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          el.setAttribute("data-ab-upload-target", token);
          sendResponse({ ok: true, result: { selector: `[data-ab-upload-target="${token}"]`, token } });
          return;
        }

        case "ab:cleanupFileUpload": {
          const token = message.payload?.token;
          if (token) {
            const el = document.querySelector(`[data-ab-upload-target="${CSS.escape(token)}"]`);
            if (el) el.removeAttribute("data-ab-upload-target");
          }
          sendResponse({ ok: true, result: { cleaned: true } });
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

chrome.runtime.onMessage.addListener(activeMessageListener);
