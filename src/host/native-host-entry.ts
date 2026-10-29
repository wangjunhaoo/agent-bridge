import net from "node:net";
import { NativeMessageDecoder, encodeNativeMessage } from "../shared/native-messaging.js";
import type { RpcRequest, RpcResponse } from "../shared/protocol.js";
import { BridgeHubServer, getDefaultSocketPath, isSocketAlive } from "./bridge-hub.js";

/**
 * Chrome Native Messaging Host 入口：
 * 当 Chrome 扩展调用 chrome.runtime.connectNative("com.antigravity.chrome") 时由操作系统拉起。
 * - 若本地尚未运行 BridgeHubServer，则本进程直接绑定 ~/.agent-bridge/bridge.sock 充当 Hub；
 * - 若本地已有 BridgeHubServer 正在监听（例如 MCP Server 先启动），则本进程以 extension 角色接入该 Socket。
 */
export async function runNativeHostProcess(socketPath = getDefaultSocketPath()): Promise<void> {
  let hubServer: BridgeHubServer | null = null;
  let hubClientSocket: net.Socket | null = null;
  let initialized = false;
  const earlyMessages: any[] = [];

  const writeToChrome = (req: RpcRequest) => {
    const frame = encodeNativeMessage(req);
    process.stdout.write(frame);
  };

  const handleDecodedMessage = (msg: any) => {
    if (!msg || typeof msg !== "object") return;
    if (!initialized) {
      earlyMessages.push(msg);
      return;
    }

    if (msg.type === "extension:hello") {
      if (hubServer) {
        hubServer.setInProcessExtension(
          { sendToExtension: writeToChrome },
          { extensionId: msg.extensionId, version: msg.version }
        );
      } else if (hubClientSocket && !hubClientSocket.destroyed) {
        hubClientSocket.write(
          JSON.stringify({
            type: "register:extension",
            extensionId: msg.extensionId,
            version: msg.version
          }) + "\n"
        );
      }
      return;
    }

    if (msg.id && typeof msg.ok === "boolean") {
      const response = msg as RpcResponse;
      if (hubServer) {
        hubServer.handleExtensionResponse(response);
      } else if (hubClientSocket && !hubClientSocket.destroyed) {
        hubClientSocket.write(JSON.stringify(response) + "\n");
      }
    }
  };

  // 立即在同步入口绑定 stdin，防止异步初始化期间丢失 Chrome 首帧或事件循环提前退出
  const decoder = new NativeMessageDecoder(handleDecodedMessage);
  process.stdin.on("data", (chunk: Buffer) => {
    decoder.push(chunk);
  });
  process.stdin.resume();

  const cleanup = async () => {
    if (hubClientSocket) {
      hubClientSocket.destroy();
    }
    if (hubServer) {
      await hubServer.close();
    }
    process.exit(0);
  };

  process.stdin.on("end", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  const alive = await isSocketAlive(socketPath);
  if (!alive) {
    hubServer = new BridgeHubServer(socketPath);
    hubServer.setInProcessExtension({ sendToExtension: writeToChrome });
    await hubServer.listen();
  } else {
    hubClientSocket = net.createConnection(socketPath);
    await new Promise<void>((resolve) => {
      hubClientSocket!.once("connect", () => {
        hubClientSocket?.write(
          JSON.stringify({
            type: "register:extension",
            pid: process.pid
          }) + "\n"
        );
        resolve();
      });
      hubClientSocket!.once("error", () => resolve());
    });

    let sockBuf = "";
    hubClientSocket.on("data", (chunk) => {
      sockBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = sockBuf.indexOf("\n")) !== -1) {
        const line = sockBuf.slice(0, nl).trim();
        sockBuf = sockBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const req = JSON.parse(line) as RpcRequest;
          if (req.id && req.method) {
            writeToChrome(req);
          }
        } catch {}
      }
    });
  }

  initialized = true;
  for (const m of earlyMessages.splice(0)) {
    handleDecodedMessage(m);
  }
}
