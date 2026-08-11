import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GSC_ROW_LIMIT = 25_000;
export const GSC_MAX_PAGES = 10;
export const GSC_DATASETS = ['SITE', 'QUERY', 'PAGE', 'QUERY_PAGE'] as const;
export type GscDataset = (typeof GSC_DATASETS)[number];
export type GscCoverage = 'COMPLETE_AS_RETURNED' | 'POSSIBLY_TRUNCATED' | 'PARTIAL' | 'FAILED';
export type GscMetricRow = {
  date: string;
  query?: string;
  page?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};
export type SearchAnalyticsRequest = {
  propertyUri: string;
  startDate: string;
  endDate: string;
  dimensions: string[];
  type: 'web';
  dataState: 'final';
  rowLimit: number;
  startRow: number;
};
export interface SearchConsoleApi {
  listProperties(): Promise<Array<{ propertyUri: string; permissionLevel: string }>>;
  query(request: SearchAnalyticsRequest): Promise<{ rows: GscMetricRow[] }>;
}

function encryptionKey(value = process.env.APP_ENCRYPTION_KEY) {
  if (!value)
    throw Object.assign(new Error('APP_ENCRYPTION_KEY is required'), { code: 'AUTH_REQUIRED' });
  const decoded = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (decoded.length !== 32)
    throw Object.assign(new Error('APP_ENCRYPTION_KEY must encode exactly 32 bytes'), {
      code: 'AUTH_REQUIRED',
    });
  return decoded;
}

export function encryptSecret(value: string, keyValue?: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptSecret(value: string, keyValue?: string) {
  const [version, iv, tag, encrypted] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted)
    throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(keyValue),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function createOAuthState() {
  const value = randomBytes(32).toString('base64url');
  return { value, hash: hashOAuthState(value) };
}
export function hashOAuthState(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function googleOAuthUrl(config: { clientId: string; redirectUri: string; state: string }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GSC_READONLY_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state: config.state,
  }).toString();
  return url.toString();
}

export function requireGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  encryptionKey();
  if (!clientId || !clientSecret || !redirectUri)
    throw Object.assign(new Error('Google OAuth environment is not configured'), {
      code: 'AUTH_REQUIRED',
    });
  return { clientId, clientSecret, redirectUri };
}

async function googleRequest<T>(url: string, init: RequestInit, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return (await response.json()) as T;
      const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
      if (!retryable || attempt >= retries) {
        const code =
          response.status === 401
            ? 'AUTH_REQUIRED'
            : response.status === 403
              ? 'PROPERTY_ACCESS_LOST'
              : response.status === 429
                ? 'QUOTA_EXCEEDED'
                : 'GOOGLE_API_ERROR';
        throw Object.assign(new Error(`Google API request failed (${response.status})`), { code });
      }
      const retryAfter = Number(response.headers.get('retry-after') ?? 0) * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfter, 250 * 2 ** attempt)));
    } catch (error) {
      if ((error as { code?: string }).code) throw error;
      if (attempt >= retries)
        throw Object.assign(new Error('Google API network request failed'), {
          code: 'NETWORK_ERROR',
        });
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

export async function exchangeGoogleCode(code: string, config = requireGoogleConfig()) {
  return googleRequest<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  }>('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
}

export async function refreshGoogleToken(refreshToken: string, config = requireGoogleConfig()) {
  try {
    return await googleRequest<{
      access_token: string;
      expires_in: number;
      scope?: string;
      token_type: string;
    }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
  } catch (error) {
    throw Object.assign(new Error('Google token refresh failed'), {
      code: 'TOKEN_REFRESH_FAILED',
      cause: error,
    });
  }
}

export class GoogleSearchConsoleApi implements SearchConsoleApi {
  constructor(private accessToken: string) {}
  async listProperties() {
    const result = await googleRequest<{
      siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>;
    }>('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { authorization: `Bearer ${this.accessToken}` },
    });
    return (result.siteEntry ?? []).map((item) => ({
      propertyUri: item.siteUrl,
      permissionLevel: item.permissionLevel,
    }));
  }
  async query(request: SearchAnalyticsRequest) {
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(request.propertyUri)}/searchAnalytics/query`;
    const result = await googleRequest<{
      rows?: Array<{
        keys?: string[];
        clicks?: number;
        impressions?: number;
        ctr?: number;
        position?: number;
      }>;
    }>(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        startDate: request.startDate,
        endDate: request.endDate,
        dimensions: request.dimensions,
        type: request.type,
        dataState: request.dataState,
        rowLimit: request.rowLimit,
        startRow: request.startRow,
      }),
    });
    return { rows: (result.rows ?? []).map((row) => rowFromKeys(request.dimensions, row)) };
  }
}

function rowFromKeys(
  dimensions: string[],
  row: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number },
): GscMetricRow {
  const values = Object.fromEntries(
    dimensions.map((dimension, index) => [dimension, row.keys?.[index]]),
  );
  return {
    date: values.date ?? '',
    query: values.query,
    page: values.page,
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  };
}

export function dimensionsFor(dataset: GscDataset) {
  return dataset === 'SITE'
    ? ['date']
    : dataset === 'QUERY'
      ? ['date', 'query']
      : dataset === 'PAGE'
        ? ['date', 'page']
        : ['date', 'query', 'page'];
}

export async function fetchDatasetPages(options: {
  api: SearchConsoleApi;
  propertyUri: string;
  date: string;
  dataset: GscDataset;
  maxPages?: number;
  shouldCancel?: () => Promise<boolean>;
  onPage: (rows: GscMetricRow[]) => Promise<void>;
}) {
  const maxPages = options.maxPages ?? GSC_MAX_PAGES;
  let requests = 0;
  let rows = 0;
  let coverage: GscCoverage = 'COMPLETE_AS_RETURNED';
  for (let page = 0; page < maxPages; page++) {
    if (await options.shouldCancel?.())
      return { requests, rows, coverage: 'PARTIAL' as const, cancelled: true };
    const result = await options.api.query({
      propertyUri: options.propertyUri,
      startDate: options.date,
      endDate: options.date,
      dimensions: dimensionsFor(options.dataset),
      type: 'web',
      dataState: 'final',
      rowLimit: GSC_ROW_LIMIT,
      startRow: page * GSC_ROW_LIMIT,
    });
    requests++;
    rows += result.rows.length;
    if (result.rows.length) await options.onPage(result.rows);
    if (result.rows.length < GSC_ROW_LIMIT)
      return {
        requests,
        rows,
        coverage: rows >= 50_000 ? ('POSSIBLY_TRUNCATED' as const) : coverage,
        cancelled: false,
      };
    if (page === maxPages - 1) coverage = 'POSSIBLY_TRUNCATED';
  }
  return { requests, rows, coverage, cancelled: false };
}

export function aggregateMetrics(
  rows: Iterable<Pick<GscMetricRow, 'clicks' | 'impressions' | 'position'>>,
) {
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  for (const row of rows) {
    clicks += row.clicks;
    impressions += row.impressions;
    weightedPosition += row.position * row.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? weightedPosition / impressions : 0,
  };
}

export function conservativePageUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  )
    url.port = '';
  return url.toString();
}
