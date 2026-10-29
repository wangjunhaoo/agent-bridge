import { BridgeClient, BridgeHubServer, getDefaultSocketPath, isSocketAlive } from "./bridge-hub.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "browser_list_tabs",
    description:
      "List all open tabs across the user's Chrome browser (including title, URL, tabId, groupId, and whether CDP debugger is attached).",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "browser_open_tab",
    description:
      "Open a URL in the dedicated 'AI Agent' Tab Group with the visual AI cursor stage.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL to open" },
        active: {
          type: "boolean",
          description: "Whether to focus the new tab in foreground (default: false for non-intrusive background execution)"
        },
        inAgentGroup: {
          type: "boolean",
          description: "Place tab inside the dedicated 'AI Agent' color-coded tab group (default: true)"
        }
      },
      required: ["url"]
    }
  },
  {
    name: "browser_read_tabs",
    description:
      "Read clean Markdown content and text selection from one or multiple open tabs simultaneously (equivalent to @Chrome multi-tab context reading).",
    inputSchema: {
      type: "object",
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" },
          description: "Array of tabIds to read. Omit to read the currently active tab."
        },
        maxChars: {
          type: "number",
          description: "Maximum characters per tab (default: 16000)"
        }
      }
    }
  },
  {
    name: "browser_navigate",
    description: "Navigate a tab to a URL, or go back / forward / reload.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId (defaults to active tab)" },
        action: {
          type: "string",
          enum: ["url", "back", "forward", "reload"],
          description: "Navigation action (default: 'url')"
        },
        url: { type: "string", description: "Destination URL when action is 'url'" }
      }
    }
  },
  {
    name: "browser_snapshot",
    description:
      "Distill the target tab's DOM & Accessibility tree into interactive element references (e1, e2, ...) with bounding boxes, values, sensitivity flags, and optional Set-of-Mark visual highlight badges.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId (defaults to active tab)" },
        highlight: {
          type: "boolean",
          description: "Render visual Set-of-Mark (#e1, #e2) overlay badges on the page (default: false)"
        },
        viewportOnly: {
          type: "boolean",
          description: "Only collect interactive elements currently inside the viewport (default: false)"
        }
      }
    }
  },
  {
    name: "browser_move_cursor",
    description:
      "Smoothly glide the animated AI virtual mouse cursor to an interactive element (by ref or CSS selector) or viewport coordinate (x, y), triggering hover states.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId (defaults to active tab)" },
        ref: { type: "string", description: "Element reference ID from browser_snapshot, e.g. 'e5'" },
        selector: { type: "string", description: "CSS selector to glide cursor to" },
        x: { type: "number", description: "Target X coordinate if ref/selector not specified" },
        y: { type: "number", description: "Target Y coordinate if ref/selector not specified" },
        label: { type: "string", description: "Optional status label displayed on the floating cursor pill" }
      }
    }
  },
  {
    name: "browser_click",
    description:
      "Click an interactive element by its snapshot reference (e.g., 'e12') or CSS selector using hardware-level trusted CDP mouse events. Pauses for confirmation on sensitive submit/delete/pay buttons unless confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId (defaults to active tab)" },
        ref: { type: "string", description: "Element reference ID from browser_snapshot, e.g. 'e5'" },
        selector: { type: "string", description: "Fallback CSS selector if ref is not provided" },
        confirmed: {
          type: "boolean",
          description: "Set true only after user explicitly approves clicking a sensitive submit/send/delete button"
        }
      }
    }
  },
  {
    name: "browser_fill",
    description:
      "Fill text into an input, textarea, or contenteditable element by snapshot ref (e.g., 'e3') or CSS selector. Compatible with React/Vue controlled inputs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId (defaults to active tab)" },
        ref: { type: "string", description: "Element reference ID from browser_snapshot" },
        selector: { type: "string", description: "Fallback CSS selector" },
        value: { type: "string", description: "Text value to enter" },
        clear: { type: "boolean", description: "Clear existing value before typing (default: true)" },
        pressEnter: { type: "boolean", description: "Dispatch hardware Enter key after filling (default: false)" }
      },
      required: ["value"]
    }
  },
  {
    name: "browser_select",
    description: "Select an option in a <select> dropdown by option value or visible text.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId" },
        ref: { type: "string", description: "Element reference ID from browser_snapshot" },
        selector: { type: "string", description: "Fallback CSS selector" },
        value: { type: "string", description: "Option value or visible label to select" }
      },
      required: ["value"]
    }
  },
  {
    name: "browser_press_key",
    description: "Dispatch a hardware-level keyboard key press (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown') via CDP.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId" },
        key: { type: "string", description: "Key name (e.g., 'Enter', 'Escape', 'Tab')" }
      },
      required: ["key"]
    }
  },
  {
    name: "browser_scroll",
    description: "Scroll the page by pixel delta.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId" },
        deltaX: { type: "number", description: "Horizontal scroll pixels (default: 0)" },
        deltaY: { type: "number", description: "Vertical scroll pixels (default: 500, negative to scroll up)" }
      }
    }
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a screenshot of a tab (works even when the tab is in a background Tab Group) via CDP Page.captureScreenshot.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId" },
        fullPage: { type: "boolean", description: "Capture full scrollable page (default: false)" }
      }
    }
  },
  {
    name: "browser_get_console_logs",
    description:
      "[Developer Mode - Full CDP] Retrieve captured console logs and uncaught JS runtime exceptions from a tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId" },
        level: {
          type: "string",
          enum: ["log", "info", "warn", "error", "debug", "exception"],
          description: "Optional log level filter"
        },
        clear: { type: "boolean", description: "Clear buffer after reading (default: false)" }
      }
    }
  },
  {
    name: "browser_get_network_requests",
    description:
      "[Developer Mode - Full CDP] Inspect HTTP/XHR/Fetch network requests, status codes, and latency captured on a tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId" },
        urlFilter: { type: "string", description: "Optional substring to filter request URLs" },
        onlyErrors: { type: "boolean", description: "Only return failed requests or HTTP status >= 400" },
        clear: { type: "boolean", description: "Clear buffer after reading (default: false)" }
      }
    }
  },
  {
    name: "browser_get_network_response_body",
    description: "[Developer Mode - Full CDP] Fetch the response payload body of a specific network request by requestId.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId" },
        requestId: { type: "string", description: "CDP requestId from browser_get_network_requests" }
      },
      required: ["requestId"]
    }
  },
  {
    name: "browser_send_cdp_command",
    description:
      "[Developer Mode - Full CDP] Execute any raw Chrome DevTools Protocol (CDP 1.3) command on a tab (e.g. 'Runtime.evaluate', 'Performance.getMetrics', 'DOMSnapshot.captureSnapshot').",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tabId" },
        cdpMethod: { type: "string", description: "CDP domain.method name, e.g. 'Runtime.evaluate'" },
        cdpParams: { type: "object", description: "Parameters object for the CDP method" }
      },
      required: ["cdpMethod"]
    }
  }
];

const TOOL_TO_BRIDGE_METHOD: Record<string, string> = {
  browser_list_tabs: "tabs.list",
  browser_open_tab: "tabs.open",
  browser_read_tabs: "tabs.read",
  browser_navigate: "tabs.navigate",
  browser_snapshot: "dom.snapshot",
  browser_move_cursor: "dom.moveCursor",
  browser_click: "dom.click",
  browser_fill: "dom.fill",
  browser_select: "dom.select",
  browser_press_key: "dom.press",
  browser_scroll: "dom.scroll",
  browser_screenshot: "page.screenshot",
  browser_get_console_logs: "dev.getConsoleLogs",
  browser_get_network_requests: "dev.getNetworkRequests",
  browser_get_network_response_body: "dev.getNetworkResponseBody",
  browser_send_cdp_command: "dev.sendCdpCommand"
};

export async function handleMcpJsonRpc(
  request: any,
  client: BridgeClient
): Promise<any | null> {
  if (!request || typeof request !== "object") return null;
  const { id, method, params } = request;

  // Notifications without id do not return a response
  if (id === undefined || id === null) {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "agent-bridge",
          version: "1.0.0"
        }
      }
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS
      }
    };
  }

  if (method === "tools/call") {
    const toolName = params?.name as string;
    const args = (params?.arguments || {}) as Record<string, unknown>;
    const bridgeMethod = TOOL_TO_BRIDGE_METHOD[toolName];

    if (!bridgeMethod) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }]
        }
      };
    }

    const bridgeRes = await client.call(bridgeMethod, args);
    if (!bridgeRes.ok) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(bridgeRes.error, null, 2)
            }
          ]
        }
      };
    }

    if (toolName === "browser_screenshot" && bridgeRes.result?.base64Data) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "image",
              data: bridgeRes.result.base64Data,
              mimeType: bridgeRes.result.format === "jpeg" ? "image/jpeg" : "image/png"
            },
            {
              type: "text",
              text: `Captured screenshot of tab #${bridgeRes.result.tabId}`
            }
          ]
        }
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(bridgeRes.result, null, 2)
          }
        ]
      }
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`
    }
  };
}

/**
 * 启动标准 MCP Server（自适应支持换行分隔 JSON-RPC 与 Content-Length 头模式）
 */
export async function runMcpServer(socketPath = getDefaultSocketPath()): Promise<void> {
  const client = new BridgeClient(socketPath);
  let useContentLengthFraming = false;
  let rawBuffer: Buffer = Buffer.alloc(0);
  process.stdin.resume();

  // 如果当前还没有任何进程监听 bridge.sock，MCP Server 主动拉起 Hub，使后续 Chrome 启动时能直接会合
  let fallbackHub: BridgeHubServer | null = null;
  if (!(await isSocketAlive(socketPath))) {
    try {
      fallbackHub = new BridgeHubServer(socketPath);
      await fallbackHub.listen();
    } catch {
      fallbackHub = null;
    }
  }

  const sendResponse = (resObj: any) => {
    if (!resObj) return;
    const body = JSON.stringify(resObj);
    if (useContentLengthFraming) {
      const byteLen = Buffer.byteLength(body, "utf8");
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${body}`);
    } else {
      process.stdout.write(body + "\n");
    }
  };

  process.stdin.on("data", (chunk: Buffer) => {
    rawBuffer = rawBuffer.length === 0 ? chunk : Buffer.concat([rawBuffer, chunk]);

    while (rawBuffer.length > 0) {
      const headerMatch = rawBuffer.toString("utf8", 0, Math.min(rawBuffer.length, 128)).match(/^Content-Length:\s*(\d+)\r\n\r\n/i);
      if (headerMatch) {
        useContentLengthFraming = true;
        const headerByteLen = Buffer.byteLength(headerMatch[0], "utf8");
        const contentLen = parseInt(headerMatch[1], 10);
        if (rawBuffer.length < headerByteLen + contentLen) {
          break;
        }
        const jsonStr = rawBuffer.subarray(headerByteLen, headerByteLen + contentLen).toString("utf8");
        rawBuffer = rawBuffer.subarray(headerByteLen + contentLen);
        try {
          const req = JSON.parse(jsonStr);
          handleMcpJsonRpc(req, client).then(sendResponse);
        } catch {}
        continue;
      }

      const newlineIdx = rawBuffer.indexOf(0x0a); // '\n'
      if (newlineIdx === -1) break;
      const line = rawBuffer.subarray(0, newlineIdx).toString("utf8").trim();
      rawBuffer = rawBuffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        const req = JSON.parse(line);
        handleMcpJsonRpc(req, client).then(sendResponse);
      } catch {}
    }
  });

  const shutdown = async () => {
    if (fallbackHub) {
      await fallbackHub.close();
    }
    process.exit(0);
  };

  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
