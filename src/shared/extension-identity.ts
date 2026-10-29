/**
 * 确定性 RSA-2048 SPKI DER Base64 公钥。
 * 写入 manifest.json 的 "key" 字段后，Chrome 在加载未打包扩展时也会生成完全固定的 32 位扩展 ID，
 * 确保 Native Messaging Host 的 allowed_origins 无需手动修改即可直接握手。
 */
export const DEFAULT_EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6oUPFXGq6Z7Mwiego9EmCTeBxoX9PKgnxYuc2In735xEU06LCv+PzSGtL7ikQ4RiUWL05aZUyzFfJ5laHAWIktmsVGbOqHGDytPB/NqxCHFQfICsMYjU3ENoh4taLSCAIuffzxMz6YoOUeqv4zc/rHj357j0ctiMEkbvkcLADccd5bEdJLkbNQ4KMzUb3NLgpxdcsy1JOPnR1hL7nUlJPAwOD6/gtT8Lk3wqfbOdrvmfYVveaDLok2xSUNQd7ilGcDTMXFMq6/KfKkB4WASYrFr4NYTmvNe2j8yk7yV/cN1f74+dbjJ4GsoTrVq59lxtvABFDZKcW9UjGnWczc2fFwIDAQAB";

export const DEFAULT_EXTENSION_ID = "imgkbhkfdlajimeojmkibleidbcbgacf";

export const NATIVE_HOST_NAME = "com.agentbridge.chrome";
