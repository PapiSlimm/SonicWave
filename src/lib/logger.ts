/**
 * Minimal structured logger (pino-compatible call shape, zero dependencies).
 * server.ts and every module call logger.info(obj, msg) / logger.error(obj, msg).
 */
type LogObj = Record<string, unknown> | string;

function line(level: string, o: LogObj, msg?: string) {
  const base = typeof o === "string" ? { msg: o } : { ...o, msg: msg ?? (o as any).msg };
  process.stdout.write(JSON.stringify({ level, time: new Date().toISOString(), ...base }) + "\n");
}

export const logger = {
  info: (o: LogObj, msg?: string) => line("info", o, msg),
  warn: (o: LogObj, msg?: string) => line("warn", o, msg),
  error: (o: LogObj, msg?: string) => line("error", o, msg),
  debug: (o: LogObj, msg?: string) => line("debug", o, msg),
};
