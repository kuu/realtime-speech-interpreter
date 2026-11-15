// Minimal leveled logger. LOG_LEVEL = debug | info | warn | error.
import { config } from "./config.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

const threshold = levels[(config.logLevel as Level)] ?? levels.info;

function emit(level: Level, args: unknown[]): void {
  if (levels[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase()}`;
  if (level === "error" || level === "warn") console.error(line, ...args);
  else console.log(line, ...args);
}

export const log = {
  debug: (...a: unknown[]) => emit("debug", a),
  info: (...a: unknown[]) => emit("info", a),
  warn: (...a: unknown[]) => emit("warn", a),
  error: (...a: unknown[]) => emit("error", a),
};
