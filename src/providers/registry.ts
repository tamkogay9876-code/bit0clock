/**
 * Adapter registry: builds a ProviderAdapter from a ProviderConfig.
 */

import type { ProviderConfig } from '../types/index.js';
import type { FetchLike, ProviderAdapter } from './types.js';
import { OpenAICompatibleAdapter } from './openai.js';
import { AnthropicCompatibleAdapter } from './anthropic.js';
import { createXKiroAdapter } from './xkiro.js';

export interface AdapterBuildContext {
  /** Resolved API key value (already looked up from the credential store) */
  apiKey?: string;
  fetchImpl?: FetchLike;
}

export function createAdapterForProvider(
  provider: ProviderConfig,
  context: AdapterBuildContext = {},
): ProviderAdapter {
  switch (provider.type) {
    case 'openai-compatible': {
      return new OpenAICompatibleAdapter({
        id: provider.id,
        displayName: provider.id,
        baseUrl: provider.baseUrl,
        apiKey: context.apiKey,
        authStyle: provider.authStyle ?? 'bearer',
        extraHeaders: provider.defaultHeaders,
        fetchImpl: context.fetchImpl,
      });
    }

    case 'anthropic-compatible': {
      return new AnthropicCompatibleAdapter({
        id: provider.id,
        displayName: provider.id,
        baseUrl: provider.baseUrl,
        apiKey: context.apiKey,
        authStyle: provider.authStyle ?? 'x-api-key',
        extraHeaders: provider.defaultHeaders,
        fetchImpl: context.fetchImpl,
      });
    }

    case 'xkiro': {
      return createXKiroAdapter({
        protocol: provider.protocol ?? 'anthropic-messages',
        apiKey: context.apiKey,
        authStyle: provider.authStyle,
        baseUrl: provider.baseUrl,
        fetchImpl: context.fetchImpl,
      });
    }

    default: {
      const exhaustive: never = provider.type;
      throw new Error(`Unsupported provider type: ${String(exhaustive)}`);
    }
  }
}
