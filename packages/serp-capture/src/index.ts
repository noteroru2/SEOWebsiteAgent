import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'cheerio';
import { chromium, devices } from 'playwright-core';

export const SERP_PARSER_VERSION = 'google-serp-parser-v1';
export const POSITION_EXTRACTION_VERSION = 'organic-position-v1';
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

const clean = (value: string | null | undefined) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function resolveGoogleHref(rawHref: string, base = 'https://www.google.com/') {
  const url = new URL(rawHref, base);
  if (url.hostname.endsWith('google.com') && url.pathname === '/url') {
    const target = url.searchParams.get('q') ?? url.searchParams.get('url');
    if (target) return new URL(target).toString();
  }
  return url.toString();
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
