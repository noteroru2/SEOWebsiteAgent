import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'cheerio';
import { chromium, devices } from 'playwright-core';
import { z } from 'zod';

export const SERP_PARSER_VERSION = 'google-serp-parser-v1';
export const POSITION_EXTRACTION_VERSION = 'organic-position-v1';
export const ASSISTED_CAPTURE_VERSION = 'owner-assisted-browser-capture-v1';
export const ASSISTED_CAPTURE_MAX_BYTES = 32_768;
export type FeatureState = 'PRESENT' | 'UNKNOWN';
export type SerpFeature =
  'ADS' | 'AI_OVERVIEW' | 'MAP_PACK' | 'PEOPLE_ALSO_ASK' | 'SHOPPING_OR_PRODUCT_RESULTS' | 'OTHER';

export type SerpExtraction = {
  blocked: boolean;
  blockedReason: string | null;
  displayedTitle: string | null;
  displayedSnippet: string | null;
  rawGoogleHref: string | null;
  resolvedLandingUrl: string | null;
  approximateOrganicPosition: number | null;
  features: Record<SerpFeature, FeatureState>;
  lowConfidenceFields: string[];
  parserVersion: string;
  positionExtractionVersion: string;
};

const featureStateSchema = z.enum(['PRESENT', 'UNKNOWN']);
export const assistedCapturePayloadSchema = z
  .object({
    token: z.string().min(32).max(256),
    opportunityId: z.string().uuid(),
    query: z.string().min(1).max(500),
    capturedAt: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).max(100),
    userAgent: z.string().min(1).max(512),
    viewport: z.object({
      width: z.number().int().min(1).max(10_000),
      height: z.number().int().min(1).max(10_000),
    }),
    googleDisplayedLocation: z.string().max(300).nullable(),
    displayedTitle: z.string().max(1_000).nullable(),
    displayedSnippet: z.string().max(5_000).nullable(),
    rawHref: z.string().max(8_000).nullable(),
    resolvedLandingUrl: z.string().url().max(8_000).nullable(),
    approximateOrganicPosition: z.number().int().min(1).max(1_000).nullable(),
    features: z.object({
      ADS: featureStateSchema,
      AI_OVERVIEW: featureStateSchema,
      MAP_PACK: featureStateSchema,
      PEOPLE_ALSO_ASK: featureStateSchema,
      SHOPPING_OR_PRODUCT_RESULTS: featureStateSchema,
      OTHER: featureStateSchema,
    }),
    lowConfidenceFields: z.array(z.string().max(100)).max(20),
    collectorVersion: z.literal(ASSISTED_CAPTURE_VERSION),
  })
  .strict();
export type AssistedCapturePayload = z.infer<typeof assistedCapturePayloadSchema>;

export function assistedCapturePayloadWithinBounds(raw: string) {
  return new TextEncoder().encode(raw).byteLength <= ASSISTED_CAPTURE_MAX_BYTES;
}

const clean = (value: string | null | undefined) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function resolveGoogleHref(rawHref: string, base = 'https://www.google.com/') {
  const url = new URL(rawHref, base);
  if (
    /^(?:[a-z0-9-]+\.)*google\.(?:com|[a-z]{2,3})(?:\.[a-z]{2})?$/i.test(url.hostname) &&
    ['/url', '/goto'].includes(url.pathname)
  ) {
    const target =
      url.searchParams.get('q') ?? url.searchParams.get('url') ?? url.searchParams.get('adurl');
    if (target) return new URL(target).toString();
  }
  return url.toString();
}

export function isAllowedGoogleOrigin(origin: string | null) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'https:' &&
      /^(?:[a-z0-9-]+\.)*google\.(?:com|[a-z]{2,3})(?:\.[a-z]{2})?$/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function ownerAssistedCollector(
  endpoint: string,
  token: string,
  opportunityId: string,
  expectedQuery: string,
  targetDomain: string,
) {
  const compact = (value: string | null | undefined) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const googleHost = (host: string) =>
    /^(?:[a-z0-9-]+\.)*google\.(?:com|[a-z]{2,3})(?:\.[a-z]{2})?$/i.test(host);
  const resolveHref = (href: string) => {
    const url = new URL(href, window.location.href);
    if (googleHost(url.hostname) && (url.pathname === '/url' || url.pathname === '/goto')) {
      const target =
        url.searchParams.get('q') || url.searchParams.get('url') || url.searchParams.get('adurl');
      if (target) return new URL(target).toString();
    }
    return url.toString();
  };
  const normalizedTarget = (href: string) => {
    try {
      const url = new URL(resolveHref(href));
      if (url.hostname.toLowerCase().replace(/^www\./, '') !== targetDomain) return null;
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  };
  const selectors = {
    ADS: '[data-text-ad],.uEierd',
    AI_OVERVIEW: '[data-attrid="SGE"],[data-mcpr]',
    MAP_PACK: '[data-local-pack],div[data-attrid="kc:/location/location:media"]',
    PEOPLE_ALSO_ASK: '[data-people-also-ask],div[jsname="N760b"]',
    SHOPPING_OR_PRODUCT_RESULTS: '[data-shopping-result],.commercial-unit-desktop-top',
    OTHER: '[data-serp-feature="other"]',
  };
  const features = Object.fromEntries(
    Object.entries(selectors).map(([name, selector]) => [
      name,
      document.querySelector(selector) ? 'PRESENT' : 'UNKNOWN',
    ]),
  );
  const organicSelector = document.querySelector('[data-organic-result]')
    ? '[data-organic-result]'
    : document.querySelector('div.MjjYud')
      ? 'div.MjjYud'
      : document.querySelector('div.tF2Cxc')
        ? 'div.tF2Cxc'
        : null;
  const organic = organicSelector
    ? Array.from(document.querySelectorAll(organicSelector)).filter(
        (node) => !node.closest(Object.values(selectors).join(',')),
      )
    : [];
  let target: Element | null = null;
  let rawHref: string | null = null;
  let resolvedLandingUrl: string | null = null;
  let position: number | null = null;
  for (let index = 0; index < organic.length; index += 1) {
    const link = organic[index]?.querySelector('a[href]') as HTMLAnchorElement | null;
    if (!link) continue;
    const resolved = normalizedTarget(link.getAttribute('href') || link.href);
    if (!resolved) continue;
    target = organic[index] ?? null;
    rawHref = link.getAttribute('href') || link.href;
    resolvedLandingUrl = resolved;
    position = index + 1;
    break;
  }
  const title = target ? compact(target.querySelector('h3')?.textContent) || null : null;
  const snippet = target
    ? compact(target.querySelector('[data-snippet],.VwiC3b,.IsZvec')?.textContent) || null
    : null;
  const query = new URL(window.location.href).searchParams.get('q') || '';
  const lowConfidenceFields = [
    ...(!organicSelector ? ['domStructure', 'approximateOrganicPosition'] : []),
    ...(target && !title ? ['displayedTitle'] : []),
    ...(target && !snippet ? ['displayedSnippet'] : []),
    ...(query !== expectedQuery ? ['query'] : []),
  ];
  const body = {
    token,
    opportunityId,
    query,
    capturedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UNKNOWN',
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    googleDisplayedLocation:
      compact(
        document.querySelector('[data-google-displayed-location],#swml,.dfB0uf')?.textContent,
      ) || null,
    displayedTitle: title,
    displayedSnippet: snippet,
    rawHref,
    resolvedLandingUrl,
    approximateOrganicPosition: organicSelector ? position : null,
    features,
    lowConfidenceFields,
    collectorVersion: 'owner-assisted-browser-capture-v1',
  };
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error((await response.json()).error || 'Capture rejected');
      window.alert('SERP observation captured. Return to SEO Website Agent to review it.');
    })
    .catch((error) => window.alert(`SERP capture failed: ${error.message}`));
}

export function createOwnerAssistedBookmarklet(input: {
  endpoint: string;
  token: string;
  opportunityId: string;
  expectedQuery: string;
  targetDomain: string;
}) {
  const args = [
    input.endpoint,
    input.token,
    input.opportunityId,
    input.expectedQuery,
    input.targetDomain,
  ].map((value) => JSON.stringify(value));
  return `javascript:(${ownerAssistedCollector.toString()})(${args.join(',')})`;
}

function normalizedTarget(urlValue: string, targetDomain: string) {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== targetDomain.toLowerCase().replace(/^www\./, '')) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function extractGoogleSerp(html: string, targetDomain: string): SerpExtraction {
  const $ = load(html);
  const pageText = clean($('body').text()).toLowerCase();
  const blocked = Boolean(
    $('#captcha-form, form[action*="sorry"], [data-captcha]').length ||
    pageText.includes('unusual traffic') ||
    pageText.includes('ตรวจพบการเข้าชมที่ผิดปกติ'),
  );
  const featureSelectors: Record<SerpFeature, string> = {
    ADS: '[data-serp-feature="ads"], [data-text-ad], .uEierd',
    AI_OVERVIEW: '[data-serp-feature="ai-overview"], [data-attrid="SGE"]',
    MAP_PACK: '[data-serp-feature="map-pack"], [data-local-pack]',
    PEOPLE_ALSO_ASK: '[data-serp-feature="paa"], [data-people-also-ask]',
    SHOPPING_OR_PRODUCT_RESULTS: '[data-serp-feature="shopping"], [data-shopping-result]',
    OTHER: '[data-serp-feature="other"]',
  };
  const features = Object.fromEntries(
    Object.entries(featureSelectors).map(([name, selector]) => [
      name,
      $(selector).length ? 'PRESENT' : 'UNKNOWN',
    ]),
  ) as Record<SerpFeature, FeatureState>;
  if (blocked)
    return {
      blocked: true,
      blockedReason: 'Google returned a CAPTCHA or unusual-traffic challenge',
      displayedTitle: null,
      displayedSnippet: null,
      rawGoogleHref: null,
      resolvedLandingUrl: null,
      approximateOrganicPosition: null,
      features,
      lowConfidenceFields: [],
      parserVersion: SERP_PARSER_VERSION,
      positionExtractionVersion: POSITION_EXTRACTION_VERSION,
    };

  const organicSelector = $('[data-organic-result]').length
    ? '[data-organic-result]'
    : $('div.MjjYud').length
      ? 'div.MjjYud'
      : 'div.tF2Cxc';
  const organic = $(organicSelector)
    .toArray()
    .filter((node) => !$(node).closest(Object.values(featureSelectors).join(',')).length);
  let target: ReturnType<typeof $> | null = null;
  let rawGoogleHref: string | null = null;
  let resolvedLandingUrl: string | null = null;
  let position: number | null = null;
  for (let index = 0; index < organic.length; index++) {
    const block = $(organic[index]!);
    const href = block.find('a[href]').first().attr('href');
    if (!href) continue;
    const resolved = resolveGoogleHref(href);
    const normalized = normalizedTarget(resolved, targetDomain);
    if (!normalized) continue;
    target = block;
    rawGoogleHref = href;
    resolvedLandingUrl = normalized;
    position = index + 1;
    break;
  }
  const title = target ? clean(target.find('h3').first().text()) || null : null;
  const snippet = target
    ? clean(target.find('[data-snippet], .VwiC3b, .IsZvec').first().text()) || null
    : null;
  const lowConfidenceFields = [
    ...(target && !title ? ['displayedTitle'] : []),
    ...(target && !snippet ? ['displayedSnippet'] : []),
    ...(target && position === null ? ['approximateOrganicPosition'] : []),
    ...(!$('[data-organic-result]').length ? ['domStructure'] : []),
  ];
  return {
    blocked: false,
    blockedReason: null,
    displayedTitle: title,
    displayedSnippet: snippet,
    rawGoogleHref,
    resolvedLandingUrl,
    approximateOrganicPosition: position,
    features,
    lowConfidenceFields,
    parserVersion: SERP_PARSER_VERSION,
    positionExtractionVersion: POSITION_EXTRACTION_VERSION,
  };
}

export async function captureGoogleSerp(input: {
  captureId: string;
  query: string;
  targetDomain: string;
  deviceProvenance: 'EMULATED_DESKTOP' | 'EMULATED_MOBILE';
  timezone: string;
  geolocation?: { latitude: number; longitude: number } | null;
  artifactRoot: string;
  executablePath?: string;
}) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: input.executablePath || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  try {
    const mobile = input.deviceProvenance === 'EMULATED_MOBILE';
    const context = await browser.newContext({
      ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1440, height: 1000 } }),
      locale: 'th-TH',
      timezoneId: input.timezone,
      geolocation: input.geolocation ?? undefined,
      permissions: input.geolocation ? ['geolocation'] : [],
    });
    try {
      const page = await context.newPage();
      const url = new URL('https://www.google.com/search');
      url.searchParams.set('q', input.query);
      url.searchParams.set('hl', 'th');
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1_000);
      const html = await page.content();
      const extraction = extractGoogleSerp(html, input.targetDomain);
      await mkdir(input.artifactRoot, { recursive: true });
      const screenshotPath = join(input.artifactRoot, `${input.captureId}.png`);
      const viewport = page.viewportSize() ?? { width: 1440, height: 1000 };
      const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.screenshot({
        path: screenshotPath,
        clip: { x: 0, y: 0, width: viewport.width, height: Math.min(documentHeight, 12_000) },
      });
      const screenshotSha256 = createHash('sha256')
        .update(await readFile(screenshotPath))
        .digest('hex');
      const displayedLocation = clean(
        await page
          .locator('[data-google-displayed-location], #swml, .dfB0uf')
          .first()
          .textContent()
          .catch(() => ''),
      );
      return {
        extraction,
        screenshotPath,
        screenshotSha256,
        googleDisplayedLocation: displayedLocation || null,
        capturedAt: new Date(),
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
