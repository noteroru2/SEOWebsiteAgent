import type { RobotsResult } from './types';

export function parseRobots(text: string, status: number | null, duration = 0): RobotsResult {
  const sitemaps: string[] = [];
  const rules: Array<{ allow: boolean; path: string }> = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.trim().toLowerCase();
    const value = match[2]!.trim();
    if (key === 'sitemap' && value) sitemaps.push(value);
    if (key === 'user-agent') applies = value === '*' || /seo website agent/i.test(value);
    if (applies && (key === 'allow' || key === 'disallow') && value)
      rules.push({ allow: key === 'allow', path: value });
  }
  return {
    status,
    fetched: status !== null && status >= 200 && status < 300,
    conservativeBlock: status !== null && status >= 500,
    sitemaps: [...new Set(sitemaps)],
    rules,
    fetchDurationMs: duration,
  };
}

export function robotsAllows(pathname: string, robots: RobotsResult) {
  if (robots.conservativeBlock) return false;
  const matching = robots.rules
    .filter((rule) => pathname.startsWith(rule.path))
    .sort((a, b) => b.path.length - a.path.length);
  return matching[0]?.allow ?? true;
}

export function parseSitemapXml(xml: string) {
  const locations = [...xml.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)].map((match) =>
    match[1]!.trim().replace(/&amp;/g, '&'),
  );
  return {
    type: /<sitemapindex[\s>]/i.test(xml) ? ('index' as const) : ('urlset' as const),
    locations,
  };
}
