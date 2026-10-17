/**
 * URL composition helpers.
 *
 * Avoids accidental duplication of `/v1` path segments when composing
 * a base URL (which may already include `/v1`) with an endpoint path.
 */

/**
 * Compose an endpoint URL from a base URL and a path.
 *
 * Examples:
 *   composeEndpoint('https://api.xkiro.com', '/v1/chat/completions')
 *     → 'https://api.xkiro.com/v1/chat/completions'
 *   composeEndpoint('https://api.xkiro.com/v1', '/v1/chat/completions')
 *     → 'https://api.xkiro.com/v1/chat/completions'   (no duplicate /v1)
 *   composeEndpoint('https://gateway.example.com/openai/v1', '/v1/models')
 *     → 'https://gateway.example.com/openai/v1/models'
 */
export function composeEndpoint(baseUrl: string, path: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  let endpointPath = path.trim();
  if (!endpointPath.startsWith('/')) endpointPath = `/${endpointPath}`;

  // Avoid duplicating the version segment when the base URL already has it
  if (/\/v1$/.test(base) && endpointPath.startsWith('/v1/')) {
    endpointPath = endpointPath.slice(3); // strip leading '/v1'
  }

  return base + endpointPath;
}

/**
 * Join URL with query parameters, skipping undefined values.
 */
export function withQuery(
  url: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  if (!qs) return url;
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}
