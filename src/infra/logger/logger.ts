export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
};

const levelOrder: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(scope: string, minLevel: LogLevel = "info"): Logger {
  const min = levelOrder[minLevel];

  const write = (level: LogLevel, message: string, data?: unknown) => {
    if (levelOrder[level] < min) return;
    const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}`;
    if (data === undefined) {
      console[level === "debug" ? "log" : level](line);
      return;
    }
    console[level === "debug" ? "log" : level](line, data);
  };

  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
  };
}
