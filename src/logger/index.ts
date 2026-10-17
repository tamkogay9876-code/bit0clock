/**
 * Structured logging with secret redaction
 */

import { resolve, dirname } from 'path';
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  statSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { homedir } from 'os';
import type { LoggingConfig } from '../types/index.js';

const DEFAULT_CONFIG: LoggingConfig = {
  level: 'info',
  maxSizeMb: 10,
  maxFiles: 5,
  redactSecrets: true,
};

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Patterns that might indicate secrets
const SECRET_PATTERNS = [
  /(api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|bearer|password|secret|credential)['":\s]+['"]?([a-zA-Z0-9_\-]{16,})['"]?/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
  /x-api-key:\s*\S+/gi,
];

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown> | undefined;
}

export class Logger {
  private config: LoggingConfig;
  private logFile: string | null = null;
  private currentSize: number = 0;

  constructor(config: Partial<LoggingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.file) {
      this.logFile = resolve(this.config.file.replace(/^~/, homedir()));
      this.ensureLogDir();
      this.checkRotation();
    }
  }

  private ensureLogDir(): void {
    if (!this.logFile) return;
    const dir = dirname(this.logFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private checkRotation(): void {
    if (!this.logFile || !existsSync(this.logFile)) return;

    const stats = statSync(this.logFile);
    const maxSizeBytes = this.config.maxSizeMb * 1024 * 1024;

    if (stats.size >= maxSizeBytes) {
      this.rotate();
    }

    this.currentSize = stats.size;
  }

  private rotate(): void {
    if (!this.logFile) return;

    // Remove oldest log
    const oldest = `${this.logFile}.${this.config.maxFiles}`;
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }

    // Shift existing logs
    for (let i = this.config.maxFiles - 1; i >= 1; i--) {
      const from = `${this.logFile}.${i}`;
      const to = `${this.logFile}.${i + 1}`;
      if (existsSync(from)) {
        renameSync(from, to);
      }
    }

    // Move current to .1
    renameSync(this.logFile, `${this.logFile}.1`);
    this.currentSize = 0;
  }

  private redact(message: string): string {
    if (!this.config.redactSecrets) return message;

    let redacted = message;
    for (const pattern of SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, (match) => {
        // Keep the key name but redact the value
        const parts = match.match(/^([^'":\s]+)['":\s]+/);
        if (parts) {
          return `${parts[1]}=[REDACTED]`;
        }
        return '[REDACTED]';
      });
    }
    return redacted;
  }

  private format(entry: LogEntry): string {
    const parts = [
      entry.timestamp,
      entry.level.toUpperCase().padEnd(5),
      this.redact(entry.message),
    ];

    if (entry.context) {
      const contextStr = JSON.stringify(entry.context, (key, value) => {
        if (typeof value === 'string') {
          return this.redact(value);
        }
        return value;
      });
      parts.push(contextStr);
    }

    return parts.join(' | ');
  }

  private write(entry: LogEntry): void {
    const line = this.format(entry) + '\n';

    // Console output
    if (LEVEL_PRIORITY[entry.level] >= LEVEL_PRIORITY[this.config.level]) {
      const color = this.getColor(entry.level);
      console.error(color + line.trim() + '\x1b[0m');
    }

    // File output
    if (this.logFile) {
      this.ensureLogDir();
      appendFileSync(this.logFile, line, 'utf-8');
      this.currentSize += Buffer.byteLength(line);

      if (this.currentSize >= this.config.maxSizeMb * 1024 * 1024) {
        this.rotate();
      }
    }
  }

  private getColor(level: LogLevel): string {
    switch (level) {
      case 'debug':
        return '\x1b[90m'; // Gray
      case 'info':
        return '\x1b[36m'; // Cyan
      case 'warn':
        return '\x1b[33m'; // Yellow
      case 'error':
        return '\x1b[31m'; // Red
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'debug',
      message,
      context,
    });
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      context,
    });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message,
      context,
    });
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      context,
    });
  }

  /**
   * Create a child logger with additional context
   */
  child(context: Record<string, unknown>): Logger {
    const childLogger = new Logger(this.config);
    const originalWrite = childLogger.write.bind(childLogger);

    childLogger.write = (entry: LogEntry) => {
      originalWrite({
        ...entry,
        context: { ...context, ...entry.context },
      });
    };

    return childLogger;
  }
}

// Singleton
let logger: Logger | null = null;

export function getLogger(config?: Partial<LoggingConfig>): Logger {
  if (!logger) {
    logger = new Logger(config);
  }
  return logger;
}

export function initializeLogger(config: Partial<LoggingConfig>): Logger {
  logger = new Logger(config);
  return logger;
}
