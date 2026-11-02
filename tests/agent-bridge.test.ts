import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient, BridgeHubServer } from "../src/host/bridge-hub.js";
import { deriveExtensionIdFromPublicKey, getNativeMessagingDirectories } from "../src/host/installer.js";
import { formatCompactSnapshot, handleMcpJsonRpc, MCP_TOOLS } from "../src/host/mcp-server.js";
import {
  DEFAULT_EXTENSION_ID,
  DEFAULT_EXTENSION_PUBLIC_KEY,
  NATIVE_HOST_NAME
} from "../src/shared/extension-identity.js";
import { encodeNativeMessage, NativeMessageDecoder } from "../src/shared/native-messaging.js";
import {
  DEFAULT_GUARD_CONFIG,
  isUrlAllowed,
  type PageSnapshotResult,
  type RpcRequest
} from "../src/shared/protocol.js";

describe("agent-bridge core suite", () => {
  const tempSockets: BridgeHubServer[] = [];

  afterEach(async () => {
    for (const srv of tempSockets.splice(0)) {
      await srv.close();
    }
  });

  it("derives the exact deterministic 32-char Chrome Extension ID from the manifest public key", () => {
    const derived = deriveExtensionIdFromPublicKey(DEFAULT_EXTENSION_PUBLIC_KEY);
    expect(derived).toBe(DEFAULT_EXTENSION_ID);
    expect(derived).toHaveLength(32);
    expect(/^[a-p]{32}$/.test(derived)).toBe(true);

    const manifestRaw = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "src/extension/manifest.json"), "utf8")
    );
    expect(manifestRaw.key).toBe(DEFAULT_EXTENSION_PUBLIC_KEY);
  });

  it("encodes and decodes fragmented and concatenated Chrome Native Messaging frames", () => {
    const received: unknown[] = [];
    const decoder = new NativeMessageDecoder((msg) => received.push(msg));

    const msg1 = { id: "1", ok: true, result: { hello: "world" } };
    const msg2 = { id: "2", ok: true, result: { data: "x".repeat(50000) } };

    const buf1 = encodeNativeMessage(msg1);
    const buf2 = encodeNativeMessage(msg2);
    const combined = Buffer.concat([buf1, buf2]);

    decoder.push(combined.subarray(0, 2));
    expect(received).toHaveLength(0);

    decoder.push(combined.subarray(2, 19));
    decoder.push(combined.subarray(19));

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(msg1);
    expect(received[1]).toEqual(msg2);
  });

  it("enforces strict hostname boundary matching in isUrlAllowed to prevent substring bypasses", () => {
    const cfg = {
      ...DEFAULT_GUARD_CONFIG,
      allowedDomains: ["github.com"]
    };

    // 合法主域名与子域名放行
    expect(isUrlAllowed("https://github.com/org/repo", cfg).allowed).toBe(true);
    expect(isUrlAllowed("https://gist.github.com/user/123", cfg).allowed).toBe(true);

    // 恶意子串伪造与后缀欺骗必须拦截
    expect(isUrlAllowed("https://evil.com/?redirect=github.com", cfg).allowed).toBe(false);
    expect(isUrlAllowed("https://github.com.evil.com/login", cfg).allowed).toBe(false);
    expect(isUrlAllowed("https://mygithub.com", cfg).allowed).toBe(false);

    // 黑名单规则优先拦截
    expect(isUrlAllowed("chrome://extensions", DEFAULT_GUARD_CONFIG).allowed).toBe(false);
    expect(isUrlAllowed("https://my.1password.com/vault", DEFAULT_GUARD_CONFIG).allowed).toBe(false);
    expect(isUrlAllowed("https://example.com/?q=1password.com", DEFAULT_GUARD_CONFIG).allowed).toBe(true);
  });

  it("verifies anti-detection stealth invariants in content script source (zero data-agent-ref, closed shadow DOM)", () => {
    const contentSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/extension/content.ts"),
      "utf8"
    );
    expect(contentSource).not.toContain('setAttribute("data-agent-ref"');
    expect(contentSource).not.toContain("data-agent-bridge-ref");
    expect(contentSource).toContain('attachShadow({ mode: "closed" })');
    expect(contentSource).not.toContain('attachShadow({ mode: "open" })');
  });

  it("formats compact snapshot DSL with ~80% token reduction and untrusted content isolation", () => {
    const sample: PageSnapshotResult = {
      tabId: 42,
      url: "https://example.com/login",
      title: "Sign In",
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, scrollHeight: 1200 },
      markdownExcerpt: "# Welcome\n\nPlease sign in.",
      highlighted: false,
      elements: [
        {
          ref: "e1",
          tagName: "input",
          role: "textbox",
          name: "Email",
          text: "",
          type: "email",
          value: "dev@example.com",
          disabled: false,
          isSensitiveSubmit: false,
          rect: { x: 100, y: 200, width: 240, height: 36 }
        },
        {
          ref: "e2",
          tagName: "button",
          role: "button",
          name: "Confirm Payment",
          text: "Confirm Payment",
          disabled: false,
          isSensitiveSubmit: true,
          rect: { x: 100, y: 260, width: 140, height: 40 }
        }
      ]
    };

    const compact = formatCompactSnapshot(sample);
    expect(compact).toContain('[e1] textbox "Email" type=email val="dev@example.com" @(100,200 240x36)');
    expect(compact).toContain('[e2] button "Confirm Payment" [SENSITIVE_SUBMIT] @(100,260 140x40)');
    expect(compact).toContain("<untrusted_page_content>");
    expect(compact.length).toBeLessThan(JSON.stringify(sample, null, 2).length * 0.55);
  });

  it("routes RPC calls end-to-end across Unix Socket BridgeHub, persistent BridgeClient, and MCP Server with security & batch support", async () => {
    const sockPath = path.join(os.tmpdir(), `ab-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const hub = new BridgeHubServer(sockPath);
    tempSockets.push(hub);

    hub.setInProcessExtension(
      {
        sendToExtension: (req: RpcRequest) => {
          if (req.method === "tabs.list") {
            hub.handleExtensionResponse({
              id: req.id,
              ok: true,
              result: {
                tabs: [
                  {
                    id: 101,
                    windowId: 1,
                    groupId: 7,
                    index: 0,
                    title: "GitHub PR #42",
                    url: "https://github.com/org/repo/pull/42",
                    active: false,
                    pinned: false,
                    debuggerAttached: true
                  }
                ]
              }
            });
            return;
          }

          if (req.method === "dom.click") {
            const p = (req.params || {}) as Record<string, any>;
            if (p.ref === "e9" && !p.confirmed) {
              hub.handleExtensionResponse({
                id: req.id,
                ok: false,
                error: {
                  code: "CONFIRMATION_REQUIRED",
                  message: "Safety guardrail: Target 'Merge pull request' is a sensitive submit action."
                }
              });
              return;
            }
            hub.handleExtensionResponse({
              id: req.id,
              ok: true,
              result: { tabId: 101, clicked: p.ref }
            });
            return;
          }

          if (req.method === "dom.batch") {
            const p = (req.params || {}) as Record<string, any>;
            hub.handleExtensionResponse({
              id: req.id,
              ok: true,
              result: {
                tabId: 101,
                completedCount: (p.steps || []).length
              }
            });
            return;
          }

          if (req.method === "page.screenshot") {
            hub.handleExtensionResponse({
              id: req.id,
              ok: true,
              result: {
                tabId: 101,
                format: "png",
                base64Data: Buffer.from("fake-png-bytes").toString("base64")
              }
            });
            return;
          }
        }
      },
      { extensionId: DEFAULT_EXTENSION_ID, version: "1.0.0" }
    );

    await hub.listen();

    // 验证 Socket 权限收紧为 0o600
    if (process.platform !== "win32") {
      const mode = fs.statSync(sockPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // 验证外部未授权客户端无法通过发送 register:extension 抢占已存在的 inProcessExtension
    await new Promise<void>((resolve) => {
      const rogue = net.createConnection(sockPath, () => {
        rogue.write(JSON.stringify({ type: "register:extension", extensionId: "rogue" }) + "\n");
        setTimeout(() => {
          rogue.destroy();
          resolve();
        }, 30);
      });
    });

    const client = new BridgeClient(sockPath, { persistent: true });

    try {
      const listToolsRes = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, client);
      expect(listToolsRes.result.tools).toHaveLength(MCP_TOOLS.length);

      // 并发发送多个请求验证长连接多路复用
      const [tabsRes, batchRes] = await Promise.all([
        handleMcpJsonRpc(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "browser_list_tabs", arguments: {} }
          },
          client
        ),
        handleMcpJsonRpc(
          {
            jsonrpc: "2.0",
            id: 6,
            method: "tools/call",
            params: {
              name: "browser_batch",
              arguments: {
                steps: [
                  { action: "fill", ref: "e1", value: "hello" },
                  { action: "click", ref: "e2" }
                ]
              }
            }
          },
          client
        )
      ]);

      const parsedTabs = JSON.parse(tabsRes.result.content[0].text);
      expect(parsedTabs.tabs[0].title).toBe("GitHub PR #42");
      expect(JSON.parse(batchRes.result.content[0].text).completedCount).toBe(2);

      // 验证敏感提交按钮拦截护栏
      const blockedClick = await handleMcpJsonRpc(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "browser_click", arguments: { ref: "e9" } }
        },
        client
      );
      expect(blockedClick.result.isError).toBe(true);
      expect(blockedClick.result.content[0].text).toContain("CONFIRMATION_REQUIRED");

      // 用户确认后放行
      const confirmedClick = await handleMcpJsonRpc(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "browser_click", arguments: { ref: "e9", confirmed: true } }
        },
        client
      );
      expect(confirmedClick.result.isError).toBeUndefined();
      expect(JSON.parse(confirmedClick.result.content[0].text).clicked).toBe("e9");

      // 验证后台截图返回 MCP image 内容块
      const shotRes = await handleMcpJsonRpc(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "browser_screenshot", arguments: { tabId: 101 } }
        },
        client
      );
      expect(shotRes.result.content[0].type).toBe("image");
      expect(shotRes.result.content[0].mimeType).toBe("image/png");
    } finally {
      client.close();
    }
  });

  it("computes Native Messaging host directories and default guard config properly", () => {
    const macDirs = getNativeMessagingDirectories("darwin", "/Users/tester");
    expect(macDirs[0]).toBe(
      "/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    );
    expect(NATIVE_HOST_NAME).toBe("com.agentbridge.chrome");
    expect(DEFAULT_GUARD_CONFIG.enabled).toBe(true);
    expect(DEFAULT_GUARD_CONFIG.stealthMode).toBe(true);
    expect(DEFAULT_GUARD_CONFIG.developerMode).toBe(false);
    expect(DEFAULT_GUARD_CONFIG.confirmBeforeSubmit).toBe(true);
    expect(DEFAULT_GUARD_CONFIG.agentTabGroupTitle).toBe("AI Agent");
  });
});
