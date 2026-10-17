/**
 * Provider connection service.
 *
 * Validates a candidate provider configuration before anything is saved:
 * a connection is only reported successful after configuration state
 * changed and credentials were verified when verification is practical.
 *
 * When a provider cannot be verified (no validation endpoint), the
 * connection is saved but clearly marked unverified — never presented as
 * a healthy integration.
 */

import type { AppState } from './state.js';
import type { ApiProtocol, ProviderConfig, ProviderType } from '../types/index.js';
import { createAdapterForProvider } from '../providers/registry.js';
import type { FetchLike, ProviderAdapter } from '../providers/types.js';
import { XKIRO_DEFAULT_BASE_URL } from '../providers/xkiro.js';
import { getLogger } from '../logger/index.js';

export interface ConnectRequest {
  providerType: ProviderType;
  /** Provider id; defaults per type (xkiro, openai, anthropic) */
  id?: string;
  baseUrl?: string;
  /** Literal key value; stored in the credential store */
  apiKey?: string;
  /** Name of an environment variable holding the key; stored as the ref */
  apiKeyEnv?: string;
  protocol?: ApiProtocol;
  authStyle?: 'bearer' | 'x-api-key';
  /** Skip the credential validation call (default: validate) */
  skipValidation?: boolean;
  fetchImpl?: FetchLike;
}

export interface ConnectResult {
  ok: boolean;
  providerId: string;
  message: string;
  warnings: string[];
  /** True when credentials were verified with a live call */
  verified: boolean;
  modelCount?: number;
}

const DEFAULT_IDS: Record<ProviderType, string> = {
  xkiro: 'xkiro',
  'openai-compatible': 'openai',
  'anthropic-compatible': 'anthropic',
};

const DEFAULT_BASE_URLS: Record<ProviderType, string | undefined> = {
  xkiro: XKIRO_DEFAULT_BASE_URL,
  'openai-compatible': undefined, // must be provided
  'anthropic-compatible': 'https://api.anthropic.com',
};

export function credentialRefFor(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

export function defaultProviderId(type: ProviderType): string {
  return DEFAULT_IDS[type];
}

export function defaultBaseUrl(type: ProviderType): string | undefined {
  return DEFAULT_BASE_URLS[type];
}

export function defaultProtocol(type: ProviderType): ApiProtocol {
  return type === 'openai-compatible' ? 'openai-chat' : 'anthropic-messages';
}

/**
 * Build the provider config a ConnectRequest describes, without saving it.
 */
export function buildProviderConfig(request: ConnectRequest): {
  config: ProviderConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const id = request.id?.trim() || DEFAULT_IDS[request.providerType];
  const baseUrl = request.baseUrl?.trim() || DEFAULT_BASE_URLS[request.providerType];

  if (!baseUrl) {
    throw new Error(
      `A base URL is required for ${request.providerType} providers (e.g. https://api.example.com/v1).`,
    );
  }

  const config: ProviderConfig = {
    id,
    type: request.providerType,
    baseUrl,
    enabled: true,
    protocol: request.protocol ?? defaultProtocol(request.providerType),
  };

  if (request.authStyle) config.authStyle = request.authStyle;

  if (request.apiKeyEnv) {
    config.credentialRef = request.apiKeyEnv;
  } else if (request.apiKey) {
    config.credentialRef = credentialRefFor(id);
  } else {
    warnings.push(`No API key provided for "${id}". Requests will fail until credentials are set.`);
  }

  return { config, warnings };
}

/**
 * Validate + persist a provider connection.
 *
 * Order matters: build → validate with the candidate config → only then
 * save config and credentials. A failed validation leaves no partial state.
 */
export async function connectProvider(
  app: AppState,
  request: ConnectRequest,
): Promise<ConnectResult> {
  const logger = getLogger();
  const { config, warnings } = buildProviderConfig(request);

  // Re-connecting an existing provider keeps its credential reference
  // unless the request supplies a new one.
  const existing = app.config.providers.find((p) => p.id === config.id);
  if (existing?.credentialRef && !request.apiKeyEnv && !request.apiKey) {
    config.credentialRef = existing.credentialRef;
  }

  // Resolve the key using the same store the runtime uses (env + file chain)
  let apiKey: string | undefined = request.apiKey;
  if (!apiKey && config.credentialRef) {
    const stored = await app.credentials.get(config.credentialRef);
    if (stored !== undefined && stored.length > 0) apiKey = stored;
  }

  const adapterOptions: { apiKey?: string; fetchImpl?: FetchLike } = {};
  if (apiKey) adapterOptions.apiKey = apiKey;
  const fetchImpl = request.fetchImpl ?? app.fetchImpl;
  if (fetchImpl) adapterOptions.fetchImpl = fetchImpl;

  const candidateAdapter: ProviderAdapter = createAdapterForProvider(config, adapterOptions);

  let verified = false;
  if (!request.skipValidation && candidateAdapter.validateCredentials) {
    const result = await candidateAdapter.validateCredentials();
    if (!result.ok) {
      return {
        ok: false,
        providerId: config.id,
        message: `Connection failed for "${config.id}": ${result.message}`,
        warnings,
        verified: false,
      };
    }
    verified = true;
  } else if (!candidateAdapter.validateCredentials && apiKey) {
    warnings.push(
      `Provider "${config.id}" has no credential validation endpoint; the key was saved but is NOT verified.`,
    );
  }

  // Validation passed (or was skipped): persist configuration
  const existingIndex = app.config.providers.findIndex((p) => p.id === config.id);
  if (existingIndex >= 0) {
    app.config.providers[existingIndex] = config;
  } else {
    app.config.providers.push(config);
  }
  if (app.configManager) {
    app.configManager.save(app.config);
  }

  // Persist the credential (literal keys only; env refs stay in the env)
  if (request.apiKey && config.credentialRef) {
    await app.credentials.set(config.credentialRef, request.apiKey);
  }

  app.invalidateAdapter(config.id);
  logger.info(`Provider connected: ${config.id} (${config.type}, verified=${verified})`);

  // Best-effort model discovery so the model picker works immediately
  let modelCount: number | undefined;
  try {
    const refresh = await app.refreshModels(config.id, true);
    modelCount = refresh.models.length;
    if (refresh.refreshError) {
      warnings.push(`Model discovery failed: ${refresh.refreshError}`);
    }
  } catch (err) {
    warnings.push(`Model discovery failed: ${(err as Error).message}`);
  }

  const verifiedNote = verified
    ? 'credentials verified'
    : candidateAdapter.validateCredentials
      ? 'credentials not verified'
      : 'credentials not verified (no validation endpoint)';

  return {
    ok: true,
    providerId: config.id,
    message:
      `Connected provider "${config.id}" (${config.type}, ${config.protocol}). ` +
      `${verifiedNote}.` +
      (modelCount !== undefined ? ` ${modelCount} model(s) discovered.` : ''),
    warnings,
    verified,
    ...(modelCount !== undefined ? { modelCount } : {}),
  };
}

export interface DisconnectOptions {
  /** Also remove the provider entry and its stored credential */
  forget?: boolean;
}

export async function disconnectProvider(
  app: AppState,
  providerId: string,
  options: DisconnectOptions = {},
): Promise<ConnectResult> {
  const logger = getLogger();
  const index = app.config.providers.findIndex((p) => p.id === providerId);
  if (index < 0) {
    return {
      ok: false,
      providerId,
      message: `Provider not configured: ${providerId}`,
      warnings: [],
      verified: false,
    };
  }

  const provider = app.config.providers[index]!;
  const warnings: string[] = [];

  if (options.forget) {
    if (provider.credentialRef) {
      const deleted = await app.credentials.delete(provider.credentialRef);
      if (!deleted) {
        warnings.push(
          `Credential "${provider.credentialRef}" was not in the file store (it may come from the environment).`,
        );
      }
    }
    app.config.providers.splice(index, 1);
    app.catalog.clearProviderCache(providerId);
    // Detach the active model if it pointed at this provider
    if (app.session.providerId === providerId) {
      delete app.session.providerId;
      delete app.session.modelId;
      app.saveSession();
    }
    if (app.configManager) app.configManager.save(app.config);
    app.invalidateAdapter(providerId);
    logger.info(`Provider removed: ${providerId}`);
    return {
      ok: true,
      providerId,
      message: `Provider "${providerId}" removed, including its saved credential.`,
      warnings,
      verified: false,
    };
  }

  provider.enabled = false;
  if (app.configManager) app.configManager.save(app.config);
  app.invalidateAdapter(providerId);
  logger.info(`Provider disabled: ${providerId}`);

  return {
    ok: true,
    providerId,
    message:
      `Provider "${providerId}" disabled. Configuration and credential are kept — ` +
      `use /connect ${providerId} to re-enable, or /disconnect ${providerId} --forget to remove.`,
    warnings,
    verified: false,
  };
}
