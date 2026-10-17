/**
 * Utility functions for mediaXG
 */

import { randomUUID } from 'crypto';
import { resolve, relative, isAbsolute, normalize } from 'path';
import { statSync, readFileSync } from 'fs';

// ============================================================================
// ID Generation
// ============================================================================

export function generateId(): string {
  return randomUUID();
}

export function generateShortId(): string {
  return randomUUID().slice(0, 8);
}

// ============================================================================
// Path Utilities
// ============================================================================

export function normalizePath(path: string): string {
  return normalize(path);
}

export function resolvePath(base: string, target: string): string {
  if (isAbsolute(target)) {
    return normalize(target);
  }
  return resolve(base, target);
}

export function isPathSafe(workspaceRoot: string, targetPath: string): boolean {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export function ensureWithinWorkspace(workspaceRoot: string, targetPath: string): string {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }

  return resolvedTarget;
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Rough token estimation - NOT accurate, use provider APIs when available
 * Average: ~4 characters per token for English text
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Rough heuristic: ~4 chars per token
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: Array<{ content: unknown }>): number {
  let total = 0;
  for (const msg of messages) {
    const content = JSON.stringify(msg.content);
    total += estimateTokens(content);
  }
  // Add overhead for message framing
  total += messages.length * 4;
  return total;
}

// ============================================================================
// String Utilities
// ============================================================================

export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

export function truncateMiddle(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  const half = Math.floor((maxLength - 3) / 2);
  return str.slice(0, half) + '...' + str.slice(-half);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatCost(cents: number, currency = 'USD'): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(4)} ${currency}`;
}

// ============================================================================
// Time Utilities
// ============================================================================

export function now(): string {
  return new Date().toISOString();
}

export function timestamp(): number {
  return Date.now();
}

// ============================================================================
// File Utilities
// ============================================================================

export function isBinaryFile(filePath: string): boolean {
  try {
    const buffer = readFileSync(filePath);
    // Check for null bytes which typically indicate binary
    for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

// ============================================================================
// Collection Utilities
// ============================================================================

export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function unique<T>(array: T[]): T[] {
  return [...new Set(array)];
}

export function groupBy<T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of array) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

// ============================================================================
// Async Utilities
// ============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = 'Operation timed out',
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryIf?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000, retryIf } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      if (retryIf && !retryIf(error)) break;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError;
}

// ============================================================================
// Parsing Utilities
// ============================================================================

export function parseModelIdentifier(identifier: string): { provider?: string; model: string } {
  const parts = identifier.split('/');
  const provider = parts[0];
  if (parts.length >= 2 && provider) {
    return { provider, model: parts.slice(1).join('/') };
  }
  return { model: identifier };
}

export function parseContextValue(value: string): number {
  const match = value.match(/^(\d+)(k|m)?$/i);
  if (!match) {
    throw new Error(`Invalid context value: ${value}`);
  }

  const num = parseInt(match[1]!, 10);
  const unit = match[2]?.toLowerCase();

  if (unit === 'k') return num * 1000;
  if (unit === 'm') return num * 1000000;
  return num;
}

// ============================================================================
// Validation Utilities
// ============================================================================

export function isValidIdentifier(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
