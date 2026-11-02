import fs from "node:fs";
import path from "node:path";
import { DEFAULT_EXTENSION_ID } from "../shared/extension-identity.js";
import type { PageSnapshotResult } from "../shared/protocol.js";
import { BridgeClient, getDefaultSocketPath } from "./bridge-hub.js";
import { installNativeMessagingHost } from "./installer.js";
import { formatCompactSnapshot, runMcpServer } from "./mcp-server.js";
import { runNativeHostProcess } from "./native-host-entry.js";

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printHelp(): void {
  const extDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../extension");
  console.log(`
agent-bridge — Control your browser with AI Agents (Native Messaging + CDP + Tab Groups)

Usage:
  agent-bridge install [--extension-id <id>]   Register Native Messaging Host for Chrome/Brave/Edge
  agent-bridge mcp                             Start MCP Server over stdio
  agent-bridge native-host                     Internal entry invoked by Chrome connectNative
  agent-bridge status                          Check bridge & extension connection status
  agent-bridge reload                          Hot-reload the Chrome extension
  agent-bridge stealth <on|off>                Toggle Stealth anti-detection mode
  agent-bridge dev <on|off>                    Toggle Developer Mode (Full CDP access)
  agent-bridge tabs                            List all open browser tabs
  agent-bridge open <url> [--foreground]       Open URL silently in 'AI Agent' Tab Group (use --foreground to focus)
  agent-bridge read [tabId...]                 Read clean Markdown context from one or more tabs
  agent-bridge snapshot [--tab <id>] [--highlight] [--compact]
                                               Distill interactive DOM/AX elements (e1, e2...)
  agent-bridge move <refOrSelectorOrX> [y] [--tab <id>]
                                               Smoothly glide the AI virtual mouse cursor to target/coords
  agent-bridge click <refOrSelector> [--tab <id>] [--confirm]
                                               Glide AI cursor + ripple + click on element ref
  agent-bridge fill <refOrSelector> <text> [--tab <id>] [--enter] [--confirm]
                                               Fill input/textarea/contenteditable element
  agent-bridge scroll [deltaY] [--ref <eId>] [--tab <id>]
                                               Scroll page or scrollable container
  agent-bridge wait [selectorOrText] [--timeout <ms>] [--tab <id>]
                                               Wait for selector/text or DOM settled
  agent-bridge upload <refOrSelector> <filePath...> [--tab <id>]
                                               Upload local file(s) to <input type="file">
  agent-bridge batch '<jsonSteps>' [--tab <id>]
                                               Execute multiple actions in a single round-trip
  agent-bridge press <key> [--tab <id>]        Dispatch key press (e.g. Enter, Escape)
  agent-bridge screenshot [out.png] [--tab <id>] [--full-page]
                                               Capture tab screenshot
  agent-bridge console [--tab <id>]            [Dev Mode] Read captured console & runtime exceptions
  agent-bridge network [--tab <id>] [--errors] [Dev Mode] Read captured HTTP/XHR network requests
  agent-bridge cdp <method> [jsonParams] [--tab <id>]
                                               [Dev Mode] Send raw CDP 1.3 command

Extension Info:
  Default Extension ID : ${DEFAULT_EXTENSION_ID}
  Unpacked Extension   : ${extDir}
`.trim());
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const subcommand = rawArgs[0];

  if (
    subcommand === "native-host" ||
    (subcommand && subcommand.startsWith("chrome-extension://"))
  ) {
    await runNativeHostProcess();
    return;
  }

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  if (subcommand === "mcp") {
    await runMcpServer();
    return;
  }

  const { positional, flags } = parseFlags(rawArgs.slice(1));

  if (subcommand === "install") {
    const extraId = typeof flags["extension-id"] === "string" ? [flags["extension-id"]] : [];
    const res = installNativeMessagingHost({ extensionIds: extraId });
    const extDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../extension");
    console.log(
      JSON.stringify(
        {
          ok: true,
          hostName: res.hostName,
          wrapperPath: res.wrapperPath,
          extensionIds: res.extensionIds,
          unpackedExtensionDirectory: extDir,
          installedManifestPaths: res.installedManifestPaths
        },
        null,
        2
      )
    );
    return;
  }

  const client = new BridgeClient(getDefaultSocketPath());
  const tabId = flags.tab !== undefined ? Number(flags.tab) : undefined;

  let response;
  switch (subcommand) {
    case "status":
      response = await client.call("bridge.status");
      break;

    case "reload":
      response = await client.call("bridge.reload");
      break;

    case "stealth": {
      const mode = positional[0];
      const enableStealth = mode === "on" || mode === "true" || mode === "1";
      response = await client.call("guard.updateConfig", {
        stealthMode: enableStealth
      });
      break;
    }

    case "dev": {
      const mode = positional[0];
      const enableDev = mode === "on" || mode === "true" || mode === "1";
      response = await client.call("guard.updateConfig", {
        developerMode: enableDev
      });
      break;
    }

    case "tabs":
      response = await client.call("tabs.list");
      break;

    case "open": {
      const url = positional[0];
      if (!url) throw new Error("Usage: agent-bridge open <url> [--foreground]");
      response = await client.call("tabs.open", {
        url,
        active: Boolean(flags.foreground || flags.active)
      });
      break;
    }

    case "read": {
      const tabIds = positional.length > 0 ? positional.map(Number) : undefined;
      response = await client.call("tabs.read", { tabId, tabIds });
      break;
    }

    case "snapshot":
      response = await client.call("dom.snapshot", {
        tabId,
        highlight: Boolean(flags.highlight ?? false),
        viewportOnly: Boolean(flags.viewport ?? false)
      });
      if (response.ok && flags.compact && response.result) {
        console.log(formatCompactSnapshot(response.result as PageSnapshotResult));
        return;
      }
      break;

    case "move": {
      const arg0 = positional[0];
      const arg1 = positional[1];
      if (!arg0) throw new Error("Usage: agent-bridge move <refOrSelectorOrX> [y] [--tab <id>]");
      if (arg1 !== undefined && !Number.isNaN(Number(arg0)) && !Number.isNaN(Number(arg1))) {
        response = await client.call("dom.moveCursor", {
          tabId,
          x: Number(arg0),
          y: Number(arg1),
          clickRipple: Boolean(flags.ripple ?? false)
        });
      } else {
        const isRef = /^e\d+$/.test(arg0);
        response = await client.call("dom.moveCursor", {
          tabId,
          ...(isRef ? { ref: arg0 } : { selector: arg0 })
        });
      }
      break;
    }

    case "click": {
      const target = positional[0];
      if (!target) throw new Error("Usage: agent-bridge click <refOrSelector> [--tab <id>] [--confirm]");
      const isRef = /^e\d+$/.test(target);
      response = await client.call("dom.click", {
        tabId,
        ...(isRef ? { ref: target } : { selector: target }),
        confirmed: Boolean(flags.confirm ?? false)
      });
      break;
    }

    case "fill": {
      const target = positional[0];
      const value = positional[1];
      if (!target || value === undefined) {
        throw new Error("Usage: agent-bridge fill <refOrSelector> <value> [--tab <id>] [--enter] [--confirm]");
      }
      const isRef = /^e\d+$/.test(target);
      response = await client.call("dom.fill", {
        tabId,
        ...(isRef ? { ref: target } : { selector: target }),
        value,
        pressEnter: Boolean(flags.enter ?? false),
        confirmed: Boolean(flags.confirm ?? false)
      });
      break;
    }

    case "scroll": {
      const dy = positional[0] !== undefined ? Number(positional[0]) : 500;
      const refFlag = typeof flags.ref === "string" ? flags.ref : undefined;
      const selFlag = typeof flags.selector === "string" ? flags.selector : undefined;
      response = await client.call("dom.scroll", {
        tabId,
        deltaY: dy,
        ref: refFlag,
        selector: selFlag
      });
      break;
    }

    case "wait": {
      const target = positional[0];
      const timeoutMs = flags.timeout !== undefined ? Number(flags.timeout) : 5000;
      const isSelector = target && (target.startsWith("#") || target.startsWith(".") || target.startsWith("["));
      response = await client.call("dom.waitFor", {
        tabId,
        ...(isSelector ? { selector: target } : target ? { text: target } : { state: "domSettled" }),
        timeoutMs
      });
      break;
    }

    case "upload": {
      const target = positional[0];
      const files = positional.slice(1).map((f) => path.resolve(f));
      if (!target || files.length === 0) {
        throw new Error("Usage: agent-bridge upload <refOrSelector> <filePath...> [--tab <id>]");
      }
      const isRef = /^e\d+$/.test(target);
      response = await client.call("dom.uploadFile", {
        tabId,
        ...(isRef ? { ref: target } : { selector: target }),
        files
      });
      break;
    }

    case "batch": {
      const rawSteps = positional[0];
      if (!rawSteps) {
        throw new Error("Usage: agent-bridge batch '<jsonStepsArray>' [--tab <id>]");
      }
      const steps = JSON.parse(rawSteps);
      response = await client.call("dom.batch", {
        tabId,
        steps
      });
      break;
    }

    case "press": {
      const key = positional[0] || "Enter";
      response = await client.call("dom.press", {
        tabId,
        key,
        confirmed: Boolean(flags.confirm ?? false)
      });
      break;
    }

    case "screenshot": {
      const outPath = positional[0] || `screenshot-${Date.now()}.png`;
      response = await client.call("page.screenshot", {
        tabId,
        fullPage: Boolean(flags["full-page"] ?? false)
      });
      if (response.ok && response.result?.base64Data) {
        fs.writeFileSync(outPath, Buffer.from(response.result.base64Data, "base64"));
        console.log(
          JSON.stringify({ ok: true, tabId: response.result.tabId, savedTo: path.resolve(outPath) }, null, 2)
        );
        return;
      }
      break;
    }

    case "console":
      response = await client.call("dev.getConsoleLogs", {
        tabId,
        clear: Boolean(flags.clear ?? false)
      });
      break;

    case "network":
      response = await client.call("dev.getNetworkRequests", {
        tabId,
        onlyErrors: Boolean(flags.errors ?? false),
        urlFilter: typeof flags.filter === "string" ? flags.filter : undefined
      });
      break;

    case "cdp": {
      const cdpMethod = positional[0];
      if (!cdpMethod) throw new Error("Usage: agent-bridge cdp <Domain.method> [jsonParams] [--tab <id>]");
      const cdpParams = positional[1] ? JSON.parse(positional[1]) : {};
      response = await client.call("dev.sendCdpCommand", {
        tabId,
        cdpMethod,
        cdpParams
      });
      break;
    }

    default:
      throw new Error(`Unknown command "${subcommand}". Run "agent-bridge --help" for usage.`);
  }

  if (!response.ok) {
    console.error(JSON.stringify(response.error, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(response.result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
