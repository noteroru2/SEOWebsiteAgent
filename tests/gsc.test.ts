import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateMetrics,
  applicationBaseUrl,
  conservativePageUrl,
  createOAuthState,
  decryptSecret,
  encryptSecret,
  fetchDatasetPages,
  googleOAuthUrl,
  GSC_READONLY_SCOPE,
  GoogleSearchConsoleApi,
  hashOAuthState,
  oauthCompletionUrl,
  refreshGoogleToken,
  type SearchConsoleApi,
} from '@seo-agent/gsc';

const key = Buffer.alloc(32, 7).toString('base64');
describe('Google Search Console security and metrics', () => {
  afterEach(() => vi.restoreAllMocks());
  it('encrypts credentials with authenticated random nonces and fails closed', () => {
    const one = encryptSecret('refresh-secret', key);
    const two = encryptSecret('refresh-secret', key);
    expect(one).not.toContain('refresh-secret');
    expect(one).not.toBe(two);
    expect(decryptSecret(one, key)).toBe('refresh-secret');
    expect(() => decryptSecret(`${one.slice(0, -1)}x`, key)).toThrow();
    const previous = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    expect(() => encryptSecret('x')).toThrow(/APP_ENCRYPTION_KEY/);
    process.env.APP_ENCRYPTION_KEY = previous;
  });
  it('creates one-time unpredictable state hashes', () => {
    const state = createOAuthState();
    expect(state.value).not.toBe(state.hash);
    expect(hashOAuthState(state.value)).toBe(state.hash);
    expect(hashOAuthState(`${state.value}x`)).not.toBe(state.hash);
  });
  it('requests only readonly offline OAuth access', () => {
    const url = new URL(
      googleOAuthUrl({
        clientId: 'id',
        redirectUri: 'http://localhost:3000/api/google/callback',
        state: 'state',
      }),
    );
    expect(url.searchParams.get('scope')).toBe(GSC_READONLY_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.has('client_secret')).toBe(false);
  });
  it('separates the server bind host from browser OAuth redirects', () => {
    const previousHostname = process.env.HOSTNAME;
    const previousBase = process.env.APP_BASE_URL;
    process.env.HOSTNAME = '0.0.0.0';
    delete process.env.APP_BASE_URL;
    const success = oauthCompletionUrl('site-id', 'success').toString();
    const failure = oauthCompletionUrl('site-id', 'error').toString();
    expect(success).toBe('http://localhost:3000/sites/site-id/search-console?connected=1');
    expect(failure).toBe('http://localhost:3000/sites/site-id/search-console?error=oauth');
    expect(success).not.toContain('0.0.0.0');
    expect(failure).not.toContain('0.0.0.0');
    expect(() => applicationBaseUrl('http://0.0.0.0:3000')).toThrow(/bind address/);
    if (previousHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = previousHostname;
    if (previousBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousBase;
  });
  it('uses impression-weighted position and aggregate CTR', () =>
    expect(
      aggregateMetrics([
        { clicks: 2, impressions: 10, position: 2 },
        { clicks: 3, impressions: 30, position: 10 },
      ]),
    ).toEqual({ clicks: 5, impressions: 40, ctr: 0.125, position: 8 }));
  it('preserves meaningful slash and query distinctions', () => {
    expect(conservativePageUrl('HTTPS://Example.COM:443/page?a=1#x')).toBe(
      'https://example.com/page?a=1',
    );
    expect(conservativePageUrl('https://example.com/page/')).not.toBe(
      conservativePageUrl('https://example.com/page'),
    );
  });
  it('paginates at 25,000 and reports a safety-cap truncation', async () => {
    const api: SearchConsoleApi = {
      listProperties: async () => [],
      query: async (req) => ({
        rows: Array.from({ length: req.rowLimit }, (_, i) => ({
          date: req.startDate,
          clicks: i,
          impressions: 1,
          ctr: 0,
          position: 1,
        })),
      }),
    };
    let rows = 0;
    const result = await fetchDatasetPages({
      api,
      propertyUri: 'sc-domain:example.com',
      date: '2026-01-01',
      dataset: 'QUERY_PAGE',
      maxPages: 2,
      onPage: async (page) => {
        rows += page.length;
      },
    });
    expect(rows).toBe(50_000);
    expect(result.coverage).toBe('POSSIBLY_TRUNCATED');
    expect(result.requests).toBe(2);
  });
  it('supports cancellation between API pages', async () => {
    let calls = 0;
    const api: SearchConsoleApi = {
      listProperties: async () => [],
      query: async (req) => {
        calls++;
        return {
          rows: Array.from({ length: req.rowLimit }, () => ({
            date: req.startDate,
            clicks: 0,
            impressions: 1,
            ctr: 0,
            position: 1,
          })),
        };
      },
    };
    const result = await fetchDatasetPages({
      api,
      propertyUri: 'x',
      date: '2026-01-01',
      dataset: 'QUERY_PAGE',
      shouldCancel: async () => calls > 0,
      onPage: async () => {},
    });
    expect(result.cancelled).toBe(true);
    expect(calls).toBe(1);
  });
  it('refreshes through the token endpoint without broadening scope', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'new-access', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    expect(
      (
        await refreshGoogleToken('refresh-secret', {
          clientId: 'id',
          clientSecret: 'secret',
          redirectUri: 'http://localhost/callback',
        })
      ).access_token,
    ).toBe('new-access');
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).not.toContain('webmasters');
  });
  it('retries bounded quota and transient server responses', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rows: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const result = await new GoogleSearchConsoleApi('access').query({
      propertyUri: 'sc-domain:example.com',
      startDate: '2026-01-01',
      endDate: '2026-01-01',
      dimensions: ['date'],
      type: 'web',
      dataState: 'final',
      rowLimit: 25_000,
      startRow: 0,
    });
    expect(result.rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
