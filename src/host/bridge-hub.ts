import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { RpcRequest, RpcResponse } from "../shared/protocol.js";

export function getDefaultSocketPath(): string {
  const dir = path.join(os.homedir(), ".agent-bridge");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  return path.join(dir, "bridge.sock");
}

export interface ExtensionPeerHandle {
  sendToExtension: (req: RpcRequest) => void;
}

interface PendingCall {
  resolve: (res: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Unix Domain Socket 多路复用中心（BridgeHubServer）
 * 负责将任意数量的 MCP Server / CLI 客户端请求路由至当前活跃的 Chrome Native Messaging 扩展通道。
 */
export class BridgeHubServer {
  private server: net.Server | null = null;
  private readonly socketPath: string;
  private inProcessExtension: ExtensionPeerHandle | null = null;
  private socketExtensionClient: net.Socket | null = null;
  private extensionMeta: { extensionId?: string; version?: string; connectedAt?: number } = {};
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly clientSockets = new Set<net.Socket>();

  constructor(socketPath = getDefaultSocketPath()) {
    this.socketPath = socketPath;
  }

  public setInProcessExtension(peer: ExtensionPeerHandle | null, meta?: { extensionId?: string; version?: string }): void {
    this.inProcessExtension = peer;
    if (peer) {
      this.extensionMeta = { ...meta, connectedAt: Date.now() };
    }
  }

  public handleExtensionResponse(res: RpcResponse): void {
    const pending = this.pendingCalls.get(res.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCalls.delete(res.id);
    pending.resolve(res);
  }

  public async listen(): Promise<void> {
    if (fs.existsSync(this.socketPath)) {
      const alive = await isSocketAlive(this.socketPath);
      if (alive) {
        throw new Error(`Socket already active at ${this.socketPath}`);
      }
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
    }

    return new Promise<void>((resolve, reject) => {
      const srv = net.createServer((socket) => this.handleClientSocket(socket));
      srv.once("error", reject);
      srv.listen(this.socketPath, () => {
        srv.removeListener("error", reject);
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch {}
        this.server = srv;
        resolve();
      });
    });
  }

  public async close(): Promise<void> {
    for (const [id, pending] of this.pendingCalls.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`BridgeHub closed while waiting for request ${id}`));
    }
    this.pendingCalls.clear();

    for (const sock of this.clientSockets) {
      sock.destroy();
    }
    this.clientSockets.clear();

    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch {}
  }

  private hasActiveExtension(): boolean {
    return Boolean(this.inProcessExtension || (this.socketExtensionClient && !this.socketExtensionClient.destroyed));
  }

  private dispatchToExtension(req: RpcRequest, timeoutMs = 25000): Promise<RpcResponse> {
    if (req.method === "hub.status") {
      return Promise.resolve({
        id: req.id,
        ok: true,
        result: {
          hubAlive: true,
          socketPath: this.socketPath,
          extensionConnected: this.hasActiveExtension(),
          extensionMeta: this.extensionMeta
        }
      });
    }

    if (!this.hasActiveExtension()) {
      return Promise.resolve({
        id: req.id,
        ok: false,
        error: {
          code: "EXTENSION_NOT_CONNECTED",
          message:
            "Chrome extension is not connected to Native Host. Ensure the AgentBridge Chrome extension is loaded and enabled."
        }
      });
    }

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(req.id);
        resolve({
          id: req.id,
          ok: false,
          error: {
            code: "TIMEOUT",
            message: `Timed out after ${timeoutMs}ms waiting for Chrome extension response to ${req.method}`
          }
        });
      }, timeoutMs);

      this.pendingCalls.set(req.id, { resolve, reject, timer });

      try {
        if (this.inProcessExtension) {
          this.inProcessExtension.sendToExtension(req);
        } else if (this.socketExtensionClient && !this.socketExtensionClient.destroyed) {
          this.socketExtensionClient.write(JSON.stringify(req) + "\n");
        }
      } catch (err) {
        clearTimeout(timer);
        this.pendingCalls.delete(req.id);
        resolve({
          id: req.id,
          ok: false,
          error: {
            code: "SEND_FAILED",
            message: err instanceof Error ? err.message : String(err)
          }
        });
      }
    });
  }

  private handleClientSocket(socket: net.Socket): void {
    this.clientSockets.add(socket);
    let buffer = "";
    let isExtensionRole = false;

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line);
          if (msg.type === "register:extension") {
            // 若当前已有进程内直连的 Native Host 通道，拒绝外部 Socket 冒充抢占
            if (this.inProcessExtension) {
              continue;
            }
            isExtensionRole = true;
            this.socketExtensionClient = socket;
            this.extensionMeta = {
              extensionId: msg.extensionId,
              version: msg.version,
              connectedAt: Date.now()
            };
            continue;
          }

          if (isExtensionRole && msg.id && typeof msg.ok === "boolean") {
            this.handleExtensionResponse(msg as RpcResponse);
            continue;
          }

          if (msg.id && msg.method) {
            this.dispatchToExtension(msg as RpcRequest, msg.timeoutMs ?? 25000).then((res) => {
              if (!socket.destroyed) {
                socket.write(JSON.stringify(res) + "\n");
              }
            });
          }
        } catch {
          // 忽略格式损坏的单行帧
        }
      }
    });

    socket.on("close", () => {
      this.clientSockets.delete(socket);
      if (isExtensionRole && this.socketExtensionClient === socket) {
        this.socketExtensionClient = null;
      }
    });

    socket.on("error", () => {});
  }
}

export async function isSocketAlive(socketPath: string, timeoutMs = 400): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });

    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * 供 MCP Server 与 CLI 使用的轻量 RPC 客户端（支持单次连接与持久多路复用连接）
 */
export class BridgeClient {
  private readonly socketPath: string;
  private readonly persistent: boolean;
  private sharedSocket: net.Socket | null = null;
  private sharedBuffer = "";
  private readonly inflight = new Map<
    string,
    { resolve: (res: RpcResponse<any>) => void; timer: NodeJS.Timeout }
  >();

  constructor(socketPath = getDefaultSocketPath(), options?: { persistent?: boolean }) {
    this.socketPath = socketPath;
    this.persistent = Boolean(options?.persistent ?? false);
  }

  public close(): void {
    if (this.sharedSocket) {
      this.sharedSocket.destroy();
      this.sharedSocket = null;
    }
    for (const [reqId, item] of this.inflight.entries()) {
      clearTimeout(item.timer);
      item.resolve({
        id: reqId,
        ok: false,
        error: { code: "CLIENT_CLOSED", message: "BridgeClient closed" }
      });
    }
    this.inflight.clear();
  }

  private getOrCreateSharedSocket(): Promise<net.Socket> {
    if (this.sharedSocket && !this.sharedSocket.destroyed) {
      return Promise.resolve(this.sharedSocket);
    }

    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      this.sharedBuffer = "";

      const onConnectError = (err: NodeJS.ErrnoException) => {
        sock.destroy();
        reject(err);
      };

      sock.once("error", onConnectError);
      sock.once("connect", () => {
        sock.removeListener("error", onConnectError);
        sock.unref();
        this.sharedSocket = sock;

        sock.on("data", (chunk) => {
          this.sharedBuffer += chunk.toString("utf8");
          let nl: number;
          while ((nl = this.sharedBuffer.indexOf("\n")) !== -1) {
            const line = this.sharedBuffer.slice(0, nl).trim();
            this.sharedBuffer = this.sharedBuffer.slice(nl + 1);
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as RpcResponse<any>;
              if (parsed && parsed.id) {
                const pending = this.inflight.get(parsed.id);
                if (pending) {
                  clearTimeout(pending.timer);
                  this.inflight.delete(parsed.id);
                  pending.resolve(parsed);
                }
              }
            } catch {}
          }
        });

        const failAll = (code: string, message: string) => {
          if (this.sharedSocket === sock) {
            this.sharedSocket = null;
          }
          for (const [reqId, pending] of this.inflight.entries()) {
            clearTimeout(pending.timer);
            pending.resolve({
              id: reqId,
              ok: false,
              error: { code, message }
            });
          }
          this.inflight.clear();
        };

        sock.on("close", () => failAll("SOCKET_CLOSED", "Bridge hub socket closed unexpectedly"));
        sock.on("error", (err) => failAll("SOCKET_ERROR", err.message));

        resolve(sock);
      });
    });
  }

  public async call<TResult = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 25000
  ): Promise<RpcResponse<TResult>> {
    const reqId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify({ id: reqId, method, params, timeoutMs }) + "\n";

    if (this.persistent) {
      try {
        const sock = await this.getOrCreateSharedSocket();
        return await new Promise<RpcResponse<TResult>>((resolve) => {
          const timer = setTimeout(() => {
            this.inflight.delete(reqId);
            resolve({
              id: reqId,
              ok: false,
              error: {
                code: "CLIENT_TIMEOUT",
                message: `BridgeClient timed out after ${timeoutMs}ms calling ${method}`
              }
            });
          }, timeoutMs + 1000);

          this.inflight.set(reqId, { resolve, timer });
          sock.write(payload);
        });
      } catch (err: any) {
        return {
          id: reqId,
          ok: false,
          error: {
            code: err?.code || "SOCKET_ERROR",
            message:
              err?.code === "ENOENT" || err?.code === "ECONNREFUSED"
                ? `Bridge hub socket (${this.socketPath}) is not active. Make sure Chrome is open with the AgentBridge extension enabled (and run "agent-bridge install" once).`
                : err?.message || String(err)
          }
        };
      }
    }

    return new Promise<RpcResponse<TResult>>((resolve) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let finished = false;

      const finish = (response: RpcResponse<TResult>) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(response);
      };

      const timer = setTimeout(() => {
        finish({
          id: reqId,
          ok: false,
          error: {
            code: "CLIENT_TIMEOUT",
            message: `BridgeClient timed out after ${timeoutMs}ms calling ${method}`
          }
        });
      }, timeoutMs + 1000);

      socket.once("connect", () => {
        socket.write(payload);
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const idx = buffer.indexOf("\n");
        if (idx !== -1) {
          const line = buffer.slice(0, idx).trim();
          try {
            const parsed = JSON.parse(line) as RpcResponse<TResult>;
            finish(parsed);
          } catch (err) {
            finish({
              id: reqId,
              ok: false,
              error: {
                code: "PARSE_ERROR",
                message: err instanceof Error ? err.message : String(err)
              }
            });
          }
        }
      });

      socket.once("error", (err: NodeJS.ErrnoException) => {
        finish({
          id: reqId,
          ok: false,
          error: {
            code: err.code || "SOCKET_ERROR",
            message:
              err.code === "ENOENT" || err.code === "ECONNREFUSED"
                ? `Bridge hub socket (${this.socketPath}) is not active. Make sure Chrome is open with the AgentBridge extension enabled (and run "agent-bridge install" once).`
                : err.message
          }
        });
      });
    });
  }
}
