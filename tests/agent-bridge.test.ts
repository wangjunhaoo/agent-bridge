import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient, BridgeHubServer } from "../src/host/bridge-hub.js";
import { deriveExtensionIdFromPublicKey, getNativeMessagingDirectories } from "../src/host/installer.js";
import { handleMcpJsonRpc, MCP_TOOLS } from "../src/host/mcp-server.js";
import {
  DEFAULT_EXTENSION_ID,
  DEFAULT_EXTENSION_PUBLIC_KEY,
  NATIVE_HOST_NAME
} from "../src/shared/extension-identity.js";
import { encodeNativeMessage, NativeMessageDecoder } from "../src/shared/native-messaging.js";
import { DEFAULT_GUARD_CONFIG, type RpcRequest } from "../src/shared/protocol.js";

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

    // 模拟任意分片到达：先切 2 字节（不足 4 字节头），再切 17 字节，最后推入剩余字节
    decoder.push(combined.subarray(0, 2));
    expect(received).toHaveLength(0);

    decoder.push(combined.subarray(2, 19));
    decoder.push(combined.subarray(19));

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(msg1);
    expect(received[1]).toEqual(msg2);
  });

  it("routes RPC calls end-to-end across Unix Socket BridgeHub, MCP Server, and simulated Extension with safety guardrails", async () => {
    const sockPath = path.join(os.tmpdir(), `ab-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const hub = new BridgeHubServer(sockPath);
    tempSockets.push(hub);

    // 模拟 Chrome Extension Service Worker 响应
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
    const client = new BridgeClient(sockPath);

    // 1. 验证 MCP tools/list
    const listToolsRes = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, client);
    expect(listToolsRes.result.tools).toHaveLength(MCP_TOOLS.length);

    // 2. 验证 MCP browser_list_tabs
    const tabsRes = await handleMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_list_tabs", arguments: {} }
      },
      client
    );
    const parsedTabs = JSON.parse(tabsRes.result.content[0].text);
    expect(parsedTabs.tabs[0].title).toBe("GitHub PR #42");
    expect(parsedTabs.tabs[0].debuggerAttached).toBe(true);

    // 3. 验证敏感提交按钮拦截护栏（未传 confirmed 时返回 CONFIRMATION_REQUIRED）
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

    // 4. 用户确认后携带 confirmed: true 放行
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

    // 5. 验证后台截图返回 MCP image 内容块
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
  });

  it("computes Native Messaging host directories and default guard config properly", () => {
    const macDirs = getNativeMessagingDirectories("darwin", "/Users/tester");
    expect(macDirs[0]).toBe(
      "/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    );
    expect(NATIVE_HOST_NAME).toBe("com.agentbridge.chrome");
    expect(DEFAULT_GUARD_CONFIG.enabled).toBe(true);
    expect(DEFAULT_GUARD_CONFIG.developerMode).toBe(false);
    expect(DEFAULT_GUARD_CONFIG.confirmBeforeSubmit).toBe(true);
    expect(DEFAULT_GUARD_CONFIG.agentTabGroupTitle).toBe("AI Agent");
  });
});
