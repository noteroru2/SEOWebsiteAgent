import { z } from 'zod';

export const providerNames = ['SERPAPI', 'SERPSTACK', 'SERPER'] as const;
export type ProviderName = (typeof providerNames)[number];
export const locationPrecisions = ['UNKNOWN', 'COUNTRY', 'REGION', 'CITY', 'COORDINATE'] as const;
export type LocationPrecision = (typeof locationPrecisions)[number];
export type SerpDevice = 'DESKTOP' | 'MOBILE' | 'TABLET';
export type FeatureState = 'PRESENT' | 'ABSENT' | 'UNKNOWN';
export const reviewPolicies = ['AUTO_ACCEPT_IF_POLICY_ALLOWS', 'OWNER_REVIEW_REQUIRED'] as const;
export type SerpReviewPolicy = (typeof reviewPolicies)[number];

export type VerifiedSerpLocationSnapshot = {
  locationProfileId: string;
  requestedLocationLabel: string;
  provider: ProviderName;
  canonicalProviderLocation: string;
  providerLocationId: string;
  verifiedPrecision: LocationPrecision;
  countryCode: string;
  timezone: string;
  verifiedAt: string;
  verificationSource: string;
};

export type SerpProviderCapabilities = {
  supportsCountry: boolean;
  supportsCity: boolean;
  supportsCoordinates: boolean;
  supportsDesktop: boolean;
  supportsMobile: boolean;
  supportsTablet: boolean;
  supportsOrganicResults: boolean;
  supportsAds: boolean;
  supportsAiOverview: boolean;
  supportsMapPack: boolean;
  supportsPaa: boolean;
  supportsShopping: boolean;
  supportsTitle: boolean;
  supportsSnippet: boolean;
  supportsResolvedUrl: boolean;
  supportsPagination: boolean;
  locationPrecision: LocationPrecision;
};

export type SerpEvidenceRequirement = {
  query: string;
  requestedLocation: string;
  requiredPrecision: LocationPrecision;
  device: SerpDevice;
  targetDomain: string;
  maxOrganicResults: 20 | 30;
};

export type NormalizedSerpResult = {
  provider: ProviderName;
  providerRequestId: string | null;
  query: string;
  requestedLocation: string;
  providerLocationUsed: string | null;
  locationPrecision: LocationPrecision;
  device: SerpDevice;
  capturedAt: string;
  organicResults: Array<{
    position: number;
    title: string;
    snippet: string | null;
    url: string;
    displayedUrl: string | null;
  }>;
  features: {
    ads: FeatureState;
    aiOverview: FeatureState;
    mapPack: FeatureState;
    peopleAlsoAsk: FeatureState;
    shopping: FeatureState;
  };
  targetFound: boolean;
  targetOrganicPosition: number | null;
  targetUrl: string | null;
  targetTitle: string | null;
  targetSnippet: string | null;
};

export type SerpProvider = {
  name: ProviderName;
  capabilities: SerpProviderCapabilities;
  search(requirement: SerpEvidenceRequirement, signal: AbortSignal): Promise<NormalizedSerpResult>;
};

export type SerpFailureCategory =
  | 'AUTH_FAILED'
  | 'FREE_QUOTA_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'CAPABILITY_MISMATCH'
  | 'PROVIDER_ERROR'
  | 'NETWORK_TIMEOUT'
  | 'UNKNOWN_FAILURE'
  | 'MALFORMED_RESPONSE';

export type SerpFailureOrigin = 'PROVIDER' | 'NETWORK' | 'ADAPTER' | 'REQUEST' | 'UNKNOWN';

export type SerpFailureDiagnostics = {
  origin: SerpFailureOrigin;
  httpStatus?: number;
  providerCode?: string;
  responseContentType?: string;
  providerRequestId?: string;
  providerStatus?: string;
};

const precisionRank: Record<LocationPrecision, number> = {
  UNKNOWN: 0,
  COUNTRY: 1,
  REGION: 2,
  CITY: 3,
  COORDINATE: 4,
};

export function capabilityMismatch(
  capabilities: SerpProviderCapabilities,
  requirement: SerpEvidenceRequirement,
) {
  if (!capabilities.supportsOrganicResults) return 'ORGANIC_RESULTS_UNSUPPORTED';
  if (precisionRank[capabilities.locationPrecision] < precisionRank[requirement.requiredPrecision])
    return 'LOCATION_PRECISION_MISMATCH';
  if (requirement.device === 'MOBILE' && !capabilities.supportsMobile) return 'DEVICE_MISMATCH';
  if (requirement.device === 'DESKTOP' && !capabilities.supportsDesktop) return 'DEVICE_MISMATCH';
  if (requirement.device === 'TABLET' && !capabilities.supportsTablet) return 'DEVICE_MISMATCH';
  return null;
}

export function classifyEvidenceRequirement(input: {
  query: string;
  requestedLocation?: string;
  device?: SerpDevice;
  targetDomain?: string;
  maxOrganicResults?: 20 | 30;
}): SerpEvidenceRequirement {
  const localSensitive = /ใกล้ฉัน|ใกล้เคียง|จังหวัด|อำเภอ|near me|nearby/i.test(input.query);
  return {
    query: input.query.trim(),
    requestedLocation: input.requestedLocation?.trim() || 'Thailand',
    requiredPrecision: localSensitive ? 'CITY' : 'COUNTRY',
    device: input.device ?? (localSensitive ? 'MOBILE' : 'DESKTOP'),
    targetDomain: input.targetDomain ?? 'amphon.co.th',
    maxOrganicResults: input.maxOrganicResults ?? 20,
  };
}

export function selectProvider(
  requirement: SerpEvidenceRequirement,
  candidates: Array<{
    provider: ProviderName;
    enabled: boolean;
    configured: boolean;
    health: string;
    remaining: number;
    priority: number;
    capabilities: SerpProviderCapabilities;
  }>,
) {
  const eligible = candidates
    .filter(
      (candidate) =>
        candidate.enabled &&
        candidate.configured &&
        candidate.health === 'AVAILABLE' &&
        candidate.remaining > 0 &&
        !capabilityMismatch(candidate.capabilities, requirement),
    )
    .sort((a, b) => {
      if (requirement.requiredPrecision === 'COUNTRY') {
        if (a.provider === 'SERPER' && b.provider !== 'SERPER') return -1;
        if (b.provider === 'SERPER' && a.provider !== 'SERPER') return 1;
      }
      return a.priority - b.priority;
    });
  return eligible[0]?.provider ?? null;
}

const organicSchema = z.object({
  position: z.number().int().positive(),
  title: z.string(),
  snippet: z.string().nullish(),
  url: z.string().url(),
  displayedUrl: z.string().nullish(),
});

function normalized(
  provider: ProviderName,
  requirement: SerpEvidenceRequirement,
  input: {
    requestId?: string | null;
    providerLocationUsed?: string | null;
    precision: LocationPrecision;
    organic: Array<z.infer<typeof organicSchema>>;
    ads?: unknown;
    aiOverview?: unknown;
    mapPack?: unknown;
    paa?: unknown;
    shopping?: unknown;
    supported: Partial<Record<'ads' | 'aiOverview' | 'mapPack' | 'paa' | 'shopping', boolean>>;
  },
): NormalizedSerpResult {
  const organicResults = input.organic
    .filter((entry, index, all) => all.findIndex((item) => item.url === entry.url) === index)
    .slice(0, requirement.maxOrganicResults)
    .map((entry) => ({
      ...entry,
      snippet: entry.snippet ?? null,
      displayedUrl: entry.displayedUrl ?? null,
    }));
  const target = organicResults.find((entry) => {
    const host = new URL(entry.url).hostname.toLowerCase().replace(/^www\./, '');
    return host === requirement.targetDomain;
  });
  const state = (value: unknown, supported: boolean): FeatureState =>
    !supported
      ? 'UNKNOWN'
      : Array.isArray(value)
        ? value.length
          ? 'PRESENT'
          : 'ABSENT'
        : value
          ? 'PRESENT'
          : 'UNKNOWN';
  return {
    provider,
    providerRequestId: input.requestId ?? null,
    query: requirement.query,
    requestedLocation: requirement.requestedLocation,
    providerLocationUsed: input.providerLocationUsed ?? null,
    locationPrecision: input.precision,
    device: requirement.device,
    capturedAt: new Date().toISOString(),
    organicResults,
    features: {
      ads: state(input.ads, input.supported.ads === true),
      aiOverview: state(input.aiOverview, input.supported.aiOverview === true),
      mapPack: state(input.mapPack, input.supported.mapPack === true),
      peopleAlsoAsk: state(input.paa, input.supported.paa === true),
      shopping: state(input.shopping, input.supported.shopping === true),
    },
    targetFound: Boolean(target),
    targetOrganicPosition: target?.position ?? null,
    targetUrl: target?.url ?? null,
    targetTitle: target?.title ?? null,
    targetSnippet: target?.snippet ?? null,
  };
}

export class SerpProviderError extends Error {
  constructor(
    public category: SerpFailureCategory,
    message: string,
    public provenNonCounted = false,
    public diagnostics: SerpFailureDiagnostics = { origin: 'UNKNOWN' },
  ) {
    super(message);
  }
}

const responseLimit = 1_048_576;
function classifyProviderDetail(detail: string): SerpFailureCategory {
  if (/quota|credit|payment|billing|usage.?limit/i.test(detail)) return 'FREE_QUOTA_EXHAUSTED';
  if (/api.?key|access.?key|auth|unauthori[sz]ed|forbidden/i.test(detail)) return 'AUTH_FAILED';
  if (/rate.?limit|too many requests/i.test(detail)) return 'RATE_LIMITED';
  if (/invalid|unsupported|parameter|location|query|bad request/i.test(detail))
    return 'INVALID_REQUEST';
  if (/timeout|temporar|unavailable|try again|gateway/i.test(detail))
    return 'TEMPORARILY_UNAVAILABLE';
  return 'PROVIDER_ERROR';
}

function boundedDiagnostic(value: unknown) {
  const text = value == null ? '' : String(value);
  return text && text.length <= 120 && !/key|token|secret|credential/i.test(text)
    ? text
    : undefined;
}

async function boundedJson(response: Response) {
  const text = await response.text();
  const responseContentType = response.headers.get('content-type')?.slice(0, 120) || undefined;
  if (new TextEncoder().encode(text).byteLength > responseLimit)
    throw new SerpProviderError('MALFORMED_RESPONSE', 'Provider response exceeded 1 MiB', false, {
      origin: 'ADAPTER',
      httpStatus: response.status,
      responseContentType,
    });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (!response.ok) {
      const diagnostics = {
        origin: 'PROVIDER' as const,
        httpStatus: response.status,
        responseContentType,
      };
      if (response.status === 401 || response.status === 403)
        throw new SerpProviderError(
          'AUTH_FAILED',
          'Provider authentication failed',
          true,
          diagnostics,
        );
      if (response.status === 402)
        throw new SerpProviderError(
          'FREE_QUOTA_EXHAUSTED',
          'Provider free quota unavailable',
          false,
          diagnostics,
        );
      if (response.status === 408)
        throw new SerpProviderError(
          'NETWORK_TIMEOUT',
          'Provider request timed out',
          false,
          diagnostics,
        );
      if (response.status === 429)
        throw new SerpProviderError(
          'RATE_LIMITED',
          'Provider rate limited the request',
          false,
          diagnostics,
        );
      if (response.status >= 500)
        throw new SerpProviderError(
          'TEMPORARILY_UNAVAILABLE',
          'Provider request failed',
          false,
          diagnostics,
        );
    }
    throw new SerpProviderError('MALFORMED_RESPONSE', 'Provider returned invalid JSON', false, {
      origin: 'ADAPTER',
      httpStatus: response.status,
      responseContentType,
    });
  }
  const diagnostics = {
    origin: 'PROVIDER' as const,
    httpStatus: response.status,
    responseContentType,
  };
  if (response.status === 401 || response.status === 403)
    throw new SerpProviderError('AUTH_FAILED', 'Provider authentication failed', true, diagnostics);
  if (response.status === 402)
    throw new SerpProviderError(
      'FREE_QUOTA_EXHAUSTED',
      'Provider free quota unavailable',
      false,
      diagnostics,
    );
  if (response.status === 429)
    throw new SerpProviderError(
      'RATE_LIMITED',
      'Provider rate limited the request',
      false,
      diagnostics,
    );
  if (response.status === 408)
    throw new SerpProviderError(
      'NETWORK_TIMEOUT',
      'Provider request timed out',
      false,
      diagnostics,
    );
  if (!response.ok) {
    const detail = JSON.stringify(body);
    const category =
      response.status === 400 || response.status === 422
        ? classifyProviderDetail(detail) === 'AUTH_FAILED'
          ? 'AUTH_FAILED'
          : 'INVALID_REQUEST'
        : response.status >= 500
          ? 'TEMPORARILY_UNAVAILABLE'
          : classifyProviderDetail(detail);
    throw new SerpProviderError(
      category,
      'Provider request failed',
      category === 'AUTH_FAILED',
      diagnostics,
    );
  }
  return { body, diagnostics };
}

const object = z.record(z.string(), z.unknown());
const organicList = (value: unknown, urlKey: 'link' | 'url') =>
  z
    .array(object)
    .default([])
    .parse(value)
    .map((row, index) =>
      organicSchema.parse({
        position: Number(row.position ?? index + 1),
        title: String(row.title ?? ''),
        snippet: row.snippet == null ? null : String(row.snippet),
        url: row[urlKey],
        displayedUrl: row.displayed_link ?? row.displayed_url ?? row.displayedUrl ?? null,
      }),
    );

export const PROVIDER_CAPABILITIES: Record<ProviderName, SerpProviderCapabilities> = {
  SERPAPI: {
    supportsCountry: true,
    supportsCity: true,
    supportsCoordinates: true,
    supportsDesktop: true,
    supportsMobile: true,
    supportsTablet: true,
    supportsOrganicResults: true,
    supportsAds: true,
    supportsAiOverview: true,
    supportsMapPack: true,
    supportsPaa: true,
    supportsShopping: true,
    supportsTitle: true,
    supportsSnippet: true,
    supportsResolvedUrl: true,
    supportsPagination: true,
    locationPrecision: 'COORDINATE',
  },
  SERPSTACK: {
    supportsCountry: true,
    supportsCity: true,
    supportsCoordinates: false,
    supportsDesktop: true,
    supportsMobile: true,
    supportsTablet: true,
    supportsOrganicResults: true,
    supportsAds: true,
    supportsAiOverview: false,
    supportsMapPack: true,
    supportsPaa: true,
    supportsShopping: true,
    supportsTitle: true,
    supportsSnippet: true,
    supportsResolvedUrl: true,
    supportsPagination: true,
    locationPrecision: 'CITY',
  },
  SERPER: {
    supportsCountry: true,
    supportsCity: false,
    supportsCoordinates: false,
    supportsDesktop: true,
    supportsMobile: false,
    supportsTablet: false,
    supportsOrganicResults: true,
    supportsAds: true,
    supportsAiOverview: false,
    supportsMapPack: true,
    supportsPaa: true,
    supportsShopping: true,
    supportsTitle: true,
    supportsSnippet: true,
    supportsResolvedUrl: true,
    supportsPagination: true,
    locationPrecision: 'COUNTRY',
  },
};

abstract class HttpProvider implements SerpProvider {
  abstract name: ProviderName;
  abstract capabilities: SerpProviderCapabilities;
  constructor(
    protected apiKey: string,
    protected fetcher: typeof fetch = fetch,
  ) {}
  abstract search(
    requirement: SerpEvidenceRequirement,
    signal: AbortSignal,
  ): Promise<NormalizedSerpResult>;
  protected async post(url: string, init: RequestInit) {
    try {
      return boundedJson(await this.fetcher(url, { ...init, signal: init.signal }));
    } catch (error) {
      if (error instanceof SerpProviderError) throw error;
      if (
        (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) ||
        init.signal?.aborted
      )
        throw new SerpProviderError('NETWORK_TIMEOUT', 'Provider request timed out', false, {
          origin: 'NETWORK',
        });
      if (error instanceof TypeError)
        throw new SerpProviderError('UNKNOWN_FAILURE', 'Provider network request failed', false, {
          origin: 'NETWORK',
        });
      throw new SerpProviderError('UNKNOWN_FAILURE', 'Provider request failed', false, {
        origin: 'UNKNOWN',
      });
    }
  }
}

export class SerpApiProvider extends HttpProvider {
  name = 'SERPAPI' as const;
  capabilities = PROVIDER_CAPABILITIES.SERPAPI;
  constructor(
    apiKey: string,
    fetcher: typeof fetch = fetch,
    private endpoint = 'https://serpapi.com/search.json',
  ) {
    super(apiKey, fetcher);
  }
  async search(requirement: SerpEvidenceRequirement, signal: AbortSignal) {
    const url = new URL(this.endpoint);
    Object.entries({
      engine: 'google',
      q: requirement.query,
      location: requirement.requestedLocation,
      gl: 'th',
      hl: 'th',
      device: requirement.device.toLowerCase(),
      num: String(requirement.maxOrganicResults),
      api_key: this.apiKey,
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    if (url.searchParams.get('q') !== requirement.query)
      throw new SerpProviderError(
        'MALFORMED_RESPONSE',
        'Provider query failed Unicode round-trip validation',
        true,
      );
    if (url.searchParams.get('location') !== requirement.requestedLocation)
      throw new SerpProviderError(
        'MALFORMED_RESPONSE',
        'Provider location failed Unicode round-trip validation',
        true,
      );
    const response = await this.post(url.toString(), { method: 'GET', signal });
    const body = object.parse(response.body);
    if (body.error) {
      const detail = JSON.stringify(body.error);
      const metadata = object.catch({}).parse(body.search_metadata);
      throw new SerpProviderError(
        classifyProviderDetail(detail),
        'SerpApi rejected the request',
        false,
        {
          ...response.diagnostics,
          providerCode: boundedDiagnostic(object.catch({}).parse(body.error).code),
          providerRequestId: boundedDiagnostic(metadata.id),
          providerStatus: boundedDiagnostic(metadata.status),
        },
      );
    }
    const params = object.catch({}).parse(body.search_parameters);
    return normalized(this.name, requirement, {
      requestId: object.catch({}).parse(body.search_metadata).id as string | undefined,
      providerLocationUsed: params.location_used as string | undefined,
      precision: requirement.requiredPrecision,
      organic: organicList(body.organic_results, 'link'),
      ads: body.ads,
      aiOverview: body.ai_overview,
      mapPack: body.local_results,
      paa: body.related_questions,
      shopping: body.shopping_results,
      supported: { ads: true, aiOverview: true, mapPack: true, paa: true, shopping: true },
    });
  }
}

export class SerpstackProvider extends HttpProvider {
  name = 'SERPSTACK' as const;
  capabilities = PROVIDER_CAPABILITIES.SERPSTACK;
  async search(requirement: SerpEvidenceRequirement, signal: AbortSignal) {
    const url = new URL('https://api.serpstack.com/search');
    Object.entries({
      access_key: this.apiKey,
      query: requirement.query,
      location: requirement.requestedLocation,
      gl: 'th',
      hl: 'th',
      device: requirement.device.toLowerCase(),
      num: String(requirement.maxOrganicResults),
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const response = await this.post(url.toString(), { method: 'GET', signal });
    const body = object.parse(response.body);
    if (body.success === false || body.error) {
      const err = JSON.stringify(body.error ?? body);
      throw new SerpProviderError(
        classifyProviderDetail(err),
        'Serpstack rejected the request',
        false,
        response.diagnostics,
      );
    }
    const params = object.catch({}).parse(body.search_parameters);
    return normalized(this.name, requirement, {
      providerLocationUsed: params.location as string | undefined,
      precision: requirement.requiredPrecision,
      organic: organicList(body.organic_results, 'url'),
      ads: body.ads,
      mapPack: body.local_results,
      paa: body.questions,
      shopping: body.shopping_results,
      supported: { ads: true, aiOverview: false, mapPack: true, paa: true, shopping: true },
    });
  }
}

export class SerperProvider extends HttpProvider {
  name = 'SERPER' as const;
  capabilities = PROVIDER_CAPABILITIES.SERPER;
  async search(requirement: SerpEvidenceRequirement, signal: AbortSignal) {
    const response = await this.post('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: requirement.query,
        gl: 'th',
        hl: 'th',
        num: requirement.maxOrganicResults,
      }),
      signal,
    });
    const body = object.parse(response.body);
    if (body.error) {
      const detail = JSON.stringify(body.error);
      throw new SerpProviderError(
        classifyProviderDetail(detail),
        'Serper rejected the request',
        false,
        response.diagnostics,
      );
    }
    return normalized(this.name, requirement, {
      precision: 'COUNTRY',
      organic: organicList(body.organic, 'link'),
      ads: body.ads,
      mapPack: body.places,
      paa: body.peopleAlsoAsk,
      shopping: body.shopping,
      supported: { ads: true, aiOverview: false, mapPack: true, paa: true, shopping: true },
    });
  }
}

export function providerFromEnv(name: ProviderName, fetcher: typeof fetch = fetch): SerpProvider {
  if (name === 'SERPAPI') return new SerpApiProvider(process.env.SERPAPI_API_KEY ?? '', fetcher);
  if (name === 'SERPSTACK')
    return new SerpstackProvider(process.env.SERPSTACK_API_KEY ?? '', fetcher);
  return new SerperProvider(process.env.SERPER_API_KEY ?? '', fetcher);
}
