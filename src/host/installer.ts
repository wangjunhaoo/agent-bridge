import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_EXTENSION_ID, NATIVE_HOST_NAME } from "../shared/extension-identity.js";

/**
 * 根据 SPKI DER Base64 公钥计算 Chrome 32 位扩展 ID（0-9a-f 映射至 a-p）
 */
export function deriveExtensionIdFromPublicKey(publicKeyBase64: string): string {
  const der = Buffer.from(publicKeyBase64, "base64");
  const hex = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  let result = "";
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    result += String.fromCharCode("a".charCodeAt(0) + nibble);
  }
  return result;
}

export interface InstallHostOptions {
  extensionIds?: string[];
  cliScriptPath?: string;
  nodeExecPath?: string;
}

export interface InstallHostResult {
  hostName: string;
  wrapperPath: string;
  extensionIds: string[];
  installedManifestPaths: string[];
}

/**
 * 获取当前系统下所有主流 Chromium 浏览器的 NativeMessagingHosts 目录
 */
export function getNativeMessagingDirectories(platform = process.platform, homeDir = os.homedir()): string[] {
  if (platform === "darwin") {
    const base = path.join(homeDir, "Library", "Application Support");
    return [
      path.join(base, "Google", "Chrome", "NativeMessagingHosts"),
      path.join(base, "Google", "Chrome Canary", "NativeMessagingHosts"),
      path.join(base, "Chromium", "NativeMessagingHosts"),
      path.join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      path.join(base, "Microsoft Edge", "NativeMessagingHosts"),
      path.join(base, "Arc", "User Data", "NativeMessagingHosts")
    ];
  }

  if (platform === "linux") {
    const configBase = path.join(homeDir, ".config");
    return [
      path.join(configBase, "google-chrome", "NativeMessagingHosts"),
      path.join(configBase, "chromium", "NativeMessagingHosts"),
      path.join(configBase, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      path.join(configBase, "microsoft-edge", "NativeMessagingHosts")
    ];
  }

  // Windows 使用 ~/.agent-bridge 作为清单存放目录
  return [path.join(homeDir, ".agent-bridge", "NativeMessagingHosts")];
}

/**
 * 生成可被 Chrome 直接执行的本地 Wrapper 脚本与 Native Messaging 清单（com.agentbridge.chrome.json）
 */
export function installNativeMessagingHost(options: InstallHostOptions = {}): InstallHostResult {
  const homeDir = os.homedir();
  const bridgeDir = path.join(homeDir, ".agent-bridge");
  fs.mkdirSync(bridgeDir, { recursive: true });

  const nodeExec = options.nodeExecPath || process.execPath;
  const cliScript =
    options.cliScriptPath || path.resolve(path.dirname(new URL(import.meta.url).pathname), "cli.js");

  const wrapperPath = path.join(bridgeDir, "native-host-wrapper.sh");
  const wrapperContent = [
    "#!/bin/sh",
    `exec "${nodeExec}" "${cliScript}" native-host "$@"`
  ].join("\n") + "\n";

  fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
  fs.chmodSync(wrapperPath, 0o755);

  const extIds = Array.from(new Set([DEFAULT_EXTENSION_ID, ...(options.extensionIds || [])])).filter(Boolean);
  const manifestObj = {
    name: NATIVE_HOST_NAME,
    description: "AgentBridge Browser Control Native Messaging Host",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: extIds.map((id) => `chrome-extension://${id}/`)
  };

  const manifestJson = JSON.stringify(manifestObj, null, 2) + "\n";
  const targetDirs = getNativeMessagingDirectories();
  const installedManifestPaths: string[] = [];

  for (const dir of targetDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const manifestPath = path.join(dir, `${NATIVE_HOST_NAME}.json`);
      fs.writeFileSync(manifestPath, manifestJson, "utf8");
      installedManifestPaths.push(manifestPath);

      // 自动清理旧版 com.antigravity.chrome.json 清单文件
      const legacyManifest = path.join(dir, "com.antigravity.chrome.json");
      if (fs.existsSync(legacyManifest)) {
        fs.unlinkSync(legacyManifest);
      }
    } catch {
      // 忽略无权限创建的目录
    }
  }

  return {
    hostName: NATIVE_HOST_NAME,
    wrapperPath,
    extensionIds: extIds,
    installedManifestPaths
  };
}
