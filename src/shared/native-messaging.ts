/**
 * Chrome Native Messaging 协议使用 32-bit 平台原生字节序（小端序）长度前缀 + UTF-8 JSON 字符串。
 * 单帧最大允许 1MB（Host -> Chrome）或 4GB（Chrome -> Host）。
 */
export function encodeNativeMessage(payload: unknown): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(jsonBytes.length, 0);
  return Buffer.concat([header, jsonBytes]);
}

/**
 * 流式解码器：处理分片到达或粘包的 Native Messaging 字节流。
 */
export class NativeMessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly onMessage: (msg: unknown) => void;
  private readonly maxMessageBytes: number;

  constructor(onMessage: (msg: unknown) => void, maxMessageBytes = 64 * 1024 * 1024) {
    this.onMessage = onMessage;
    this.maxMessageBytes = maxMessageBytes;
  }

  public push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const messageLength = this.buffer.readUInt32LE(0);
      if (messageLength > this.maxMessageBytes) {
        this.buffer = Buffer.alloc(0);
        throw new Error(`Native message length ${messageLength} exceeds limit ${this.maxMessageBytes}`);
      }
      if (this.buffer.length < 4 + messageLength) {
        break;
      }
      const payloadBuf = this.buffer.subarray(4, 4 + messageLength);
      this.buffer = this.buffer.subarray(4 + messageLength);
      const parsed = JSON.parse(payloadBuf.toString("utf8"));
      this.onMessage(parsed);
    }
  }
}
