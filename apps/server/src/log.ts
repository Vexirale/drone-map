import type { LogLevel } from './config.ts';

/**
 * The few logger methods shared code needs. Fastify's pino logger (`app.log`) fits this shape;
 * the worker and the CLI use `createLogger` below, which writes the same JSON lines as pino
 * (numeric levels, `time`, `msg`), so one log pipeline reads both.
 */
export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity } as const;

export function createLogger(level: LogLevel, base: Record<string, unknown> = {}): Logger {
  const min = LEVELS[level];
  const write = (lvl: number) => (obj: object, msg: string) => {
    if (lvl < min) return;
    const line = { level: lvl, time: Date.now(), pid: process.pid, ...base, ...obj, msg };
    // Errors have no enumerable properties; write them the way pino does.
    const replacer = (_key: string, value: unknown) =>
      value instanceof Error ? { type: value.name, message: value.message, stack: value.stack } : value;
    process.stdout.write(`${JSON.stringify(line, replacer)}\n`);
  };
  return { info: write(LEVELS.info), warn: write(LEVELS.warn), error: write(LEVELS.error) };
}
