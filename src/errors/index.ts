/**
 * Structured error handling for mediaXG
 */

import type { AppError, ErrorCategory } from '../types/index.js';

export class MediaXGError extends Error implements AppError {
  category: ErrorCategory;
  provider?: string;
  model?: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;

  constructor(options: {
    category: ErrorCategory;
    message: string;
    provider?: string | undefined;
    model?: string | undefined;
    retryable?: boolean | undefined;
    retryAfterMs?: number | undefined;
    details?: Record<string, unknown> | undefined;
    cause?: Error | undefined;
  }) {
    super(options.message);
    this.name = 'MediaXGError';
    this.category = options.category;
    this.provider = options.provider;
    this.model = options.model;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
    this.cause = options.cause;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MediaXGError);
    }
  }

  toJSON(): AppError {
    return {
      category: this.category,
      message: this.message,
      provider: this.provider,
      model: this.model,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
    };
  }
}

// ============================================================================
// Error Factory Functions
// ============================================================================

export function authError(
  message: string,
  provider?: string,
  details?: Record<string, unknown>,
): MediaXGError {
  return new MediaXGError({
    category: 'authentication',
    message,
    provider,
    retryable: false,
    details,
  });
}

export function invalidModelError(
  message: string,
  provider?: string,
  model?: string,
): MediaXGError {
  return new MediaXGError({
    category: 'invalid-model',
    message,
    provider,
    model,
    retryable: false,
  });
}

export function missingCapabilityError(
  message: string,
  provider?: string,
  model?: string,
): MediaXGError {
  return new MediaXGError({
    category: 'missing-capability',
    message,
    provider,
    model,
    retryable: false,
  });
}

export function insufficientQuotaError(
  message: string,
  provider?: string,
  details?: Record<string, unknown>,
): MediaXGError {
  return new MediaXGError({
    category: 'insufficient-quota',
    message,
    provider,
    retryable: false,
    details,
  });
}

export function rateLimitError(
  message: string,
  provider?: string,
  retryAfterMs?: number,
): MediaXGError {
  return new MediaXGError({
    category: 'rate-limit',
    message,
    provider,
    retryable: true,
    retryAfterMs,
  });
}

export function contextOverflowError(
  message: string,
  provider?: string,
  model?: string,
  details?: Record<string, unknown>,
): MediaXGError {
  return new MediaXGError({
    category: 'context-overflow',
    message,
    provider,
    model,
    retryable: false,
    details,
  });
}

export function outputLimitError(message: string, provider?: string, model?: string): MediaXGError {
  return new MediaXGError({
    category: 'output-limit',
    message,
    provider,
    model,
    retryable: false,
  });
}

export function networkError(
  message: string,
  provider?: string,
  details?: Record<string, unknown>,
): MediaXGError {
  return new MediaXGError({
    category: 'network',
    message,
    provider,
    retryable: true,
    details,
  });
}

export function serverError(
  message: string,
  provider?: string,
  details?: Record<string, unknown>,
): MediaXGError {
  return new MediaXGError({
    category: 'server',
    message,
    provider,
    retryable: true,
    details,
  });
}

export function toolValidationError(
  message: string,
  details?: Record<string, unknown>,
): MediaXGError {
  return new MediaXGError({
    category: 'tool-validation',
    message,
    retryable: false,
    details,
  });
}

export function timeoutError(message: string, provider?: string): MediaXGError {
  return new MediaXGError({
    category: 'timeout',
    message,
    provider,
    retryable: true,
  });
}

export function cancellationError(message: string = 'Operation cancelled'): MediaXGError {
  return new MediaXGError({
    category: 'cancellation',
    message,
    retryable: false,
  });
}

export function permissionDeniedError(
  message: string,
  details?: Record<string, unknown>,
): MediaXGError {
  return new MediaXGError({
    category: 'permission-denied',
    message,
    retryable: false,
    details,
  });
}

export function pathTraversalError(path: string): MediaXGError {
  return new MediaXGError({
    category: 'path-traversal',
    message: `Path traversal detected: ${path}`,
    retryable: false,
    details: { path },
  });
}

export function credentialNotFoundError(ref: string): MediaXGError {
  return new MediaXGError({
    category: 'credential-not-found',
    message: `Credential not found: ${ref}`,
    retryable: false,
    details: { ref },
  });
}

export function configInvalidError(errors: string[]): MediaXGError {
  return new MediaXGError({
    category: 'config-invalid',
    message: `Configuration invalid: ${errors.join(', ')}`,
    retryable: false,
    details: { errors },
  });
}

export function storageError(message: string, details?: Record<string, unknown>): MediaXGError {
  return new MediaXGError({
    category: 'storage-error',
    message,
    retryable: false,
    details,
  });
}

// ============================================================================
// Error Utilities
// ============================================================================

export function isRetryable(error: unknown): boolean {
  if (error instanceof MediaXGError) {
    return error.retryable;
  }
  return false;
}

export function getRetryAfter(error: unknown): number {
  if (error instanceof MediaXGError && error.retryAfterMs) {
    return error.retryAfterMs;
  }
  // Default exponential backoff
  return 1000;
}

export function normalizeError(
  error: unknown,
  context?: { provider?: string; model?: string },
): MediaXGError {
  if (error instanceof MediaXGError) {
    return error;
  }

  if (error instanceof Error) {
    // Check for common error patterns
    const message = error.message.toLowerCase();

    if (
      message.includes('401') ||
      message.includes('unauthorized') ||
      message.includes('api key')
    ) {
      return authError(error.message, context?.provider);
    }
    if (message.includes('404') || message.includes('not found') || message.includes('model')) {
      return invalidModelError(error.message, context?.provider, context?.model);
    }
    if (message.includes('429') || message.includes('rate limit')) {
      return rateLimitError(error.message, context?.provider);
    }
    if (message.includes('timeout') || message.includes('etimedout')) {
      return timeoutError(error.message, context?.provider);
    }
    if (
      message.includes('network') ||
      message.includes('econnrefused') ||
      message.includes('enotfound')
    ) {
      return networkError(error.message, context?.provider);
    }
    if (message.includes('context') && message.includes('length')) {
      return contextOverflowError(error.message, context?.provider, context?.model);
    }

    return new MediaXGError({
      category: 'unknown',
      message: error.message,
      provider: context?.provider,
      model: context?.model,
      retryable: false,
      cause: error,
    });
  }

  return new MediaXGError({
    category: 'unknown',
    message: String(error),
    provider: context?.provider,
    model: context?.model,
    retryable: false,
  });
}

export function formatError(error: unknown): string {
  if (error instanceof MediaXGError) {
    const parts = [`[${error.category}]`];
    if (error.provider) parts.push(`(${error.provider})`);
    parts.push(error.message);
    if (error.details) {
      parts.push(`Details: ${JSON.stringify(error.details)}`);
    }
    return parts.join(' ');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
