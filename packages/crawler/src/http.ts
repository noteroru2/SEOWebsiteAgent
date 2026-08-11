import { assertSafeTarget, normalizeUrl } from './url';

export interface FetchResult {
  url: string;
  status: number;
  redirects: number;
  contentType: string;
  bytes: number;
  durationMs: number;
  body: string | null;
  xRobotsTag: string | null;
  tooLarge: boolean;
}
const retryable = (status: number) =>
  status === 429 || status === 502 || status === 503 || status === 504;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function controlledFetch(
  startUrl: string,
  options: {
    timeoutMs: number;
    maxRedirects: number;
    maxRetries: number;
    maxBodyBytes: number;
    allowPrivateNetworkForTests: boolean;
    acceptXml?: boolean;
  },
): Promise<FetchResult> {
  let attempts = 0;
  while (true) {
    try {
      return await fetchOnce(startUrl, { ...options, maxRetries: options.maxRetries - attempts });
    } catch (error) {
      if (attempts++ >= options.maxRetries || (error as { code?: string }).code === 'SSRF_BLOCKED')
        throw error;
      await sleep(Math.min(250 * attempts, 1000));
    }
  }
}

async function fetchOnce(
  startUrl: string,
  options: {
    timeoutMs: number;
    maxRedirects: number;
    maxRetries: number;
    maxBodyBytes: number;
    allowPrivateNetworkForTests: boolean;
    acceptXml?: boolean;
  },
): Promise<FetchResult> {
  let current = normalizeUrl(startUrl);
  let redirects = 0;
  const started = performance.now();
  const visited = new Set<string>();
  while (true) {
    await assertSafeTarget(current, options.allowPrivateNetworkForTests);
    if (visited.has(current))
      throw Object.assign(new Error('Redirect loop'), { code: 'REDIRECT_LOOP' });
    visited.add(current);
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        'user-agent': 'SEO Website Agent/1.0 (+local read-only crawler)',
        accept: options.acceptXml
          ? 'application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1'
          : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-encoding': 'gzip, br, deflate',
      },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirects++ >= options.maxRedirects)
        throw Object.assign(new Error('Redirect limit exceeded'), { code: 'REDIRECT_LIMIT' });
      current = normalizeUrl(response.headers.get('location')!, current);
      continue;
    }
    if (retryable(response.status) && options.maxRetries > 0)
      throw Object.assign(new Error(`Retryable HTTP ${response.status}`), {
        code: 'RETRYABLE_HTTP',
      });
    const type = response.headers.get('content-type') ?? '';
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let tooLarge = false;
    if (reader)
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > options.maxBodyBytes) {
          tooLarge = true;
          await reader.cancel();
          break;
        }
        chunks.push(part.value);
      }
    const total = new Uint8Array(Math.min(bytes, options.maxBodyBytes));
    let offset = 0;
    for (const chunk of chunks) {
      total.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      url: current,
      status: response.status,
      redirects,
      contentType: type,
      bytes,
      durationMs: Math.round(performance.now() - started),
      body: tooLarge ? null : new TextDecoder().decode(total),
      xRobotsTag: response.headers.get('x-robots-tag'),
      tooLarge,
    };
  }
}
