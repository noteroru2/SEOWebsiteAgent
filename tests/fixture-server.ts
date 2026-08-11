import { createServer, type Server } from 'node:http';

const description =
  'A deterministic description long enough for crawler fixture validation and stable technical SEO checks.';
const page = (
  path: string,
  body: string,
  options: {
    title?: string | null;
    description?: string | null;
    h1?: string[];
    canonical?: string | null;
    robots?: string;
    lang?: boolean;
    viewport?: boolean;
  } = {},
) => {
  const title =
    options.title === null
      ? ''
      : `<title>${options.title ?? `Healthy fixture page ${path}`}</title>`;
  const meta =
    options.description === null
      ? ''
      : `<meta name="description" content="${options.description ?? description}">`;
  const headings = (options.h1 ?? ['Fixture heading']).map((value) => `<h1>${value}</h1>`).join('');
  const canonical =
    options.canonical === null ? '' : `<link rel="canonical" href="${options.canonical ?? path}">`;
  return `<!doctype html><html${options.lang === false ? '' : ' lang="en"'}><head>${title}${meta}${canonical}${options.robots ? `<meta name="robots" content="${options.robots}">` : ''}${options.viewport === false ? '' : '<meta name="viewport" content="width=device-width">'}</head><body>${headings}<p>${body}</p></body></html>`;
};

export async function startFixture(generatedPages = 0, port = 0) {
  let retries = 0;
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    const origin = `http://${request.headers.host ?? `127.0.0.1:${(server.address() as { port: number }).port}`}`;
    if (path === '/robots.txt')
      return send(
        response,
        200,
        `User-agent: *\nDisallow: /blocked\nSitemap: ${origin}/sitemap.xml`,
        'text/plain',
      );
    if (path === '/sitemap.xml')
      return send(
        response,
        200,
        `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sitemap-main.xml</loc></sitemap></sitemapindex>`,
        'application/xml',
      );
    if (path === '/sitemap-main.xml') {
      const fixed = [
        '/',
        '/healthy',
        '/missing-title',
        '/duplicate-title-a',
        '/duplicate-title-b',
        '/missing-description',
        '/multiple-h1',
        '/missing-h1',
        '/noindex',
        '/canonical-other',
        '/broken-source',
        '/redirect-a',
        '/not-found',
        '/server-error',
        '/blocked',
        '/duplicate-content-a',
        '/duplicate-content-b',
        '/large',
        '/external',
      ];
      const generated = Array.from(
        { length: generatedPages },
        (_, index) => `/generated/${index + 1}`,
      );
      return send(
        response,
        200,
        `<?xml version="1.0"?><urlset>${[...fixed, ...generated].map((item) => `<url><loc>${origin}${item}</loc></url>`).join('')}</urlset>`,
        'application/xml',
      );
    }
    if (path === '/redirect-a') return redirect(response, `${origin}/redirect-b`);
    if (path === '/redirect-b') return redirect(response, `${origin}/healthy`);
    if (path === '/loop-a') return redirect(response, `${origin}/loop-b`);
    if (path === '/loop-b') return redirect(response, `${origin}/loop-a`);
    if (path === '/not-found' || path === '/missing')
      return send(response, 404, page(path, 'Missing page'));
    if (path === '/server-error') return send(response, 500, page(path, 'Server error'));
    if (path === '/blocked') return send(response, 200, page(path, 'Blocked content'));
    if (path === '/slow')
      return setTimeout(() => send(response, 200, page(path, 'Slow response')), 200);
    if (path === '/retry') {
      retries++;
      return retries <= 2
        ? send(response, 503, 'temporary')
        : send(response, 200, page(path, 'Recovered response'));
    }
    if (path === '/missing-title')
      return send(response, 200, page(path, 'Missing title body', { title: null }));
    if (path === '/duplicate-title-a' || path === '/duplicate-title-b')
      return send(
        response,
        200,
        page(path, `Unique body ${path}`, {
          title: 'Shared duplicate title for fixture validation',
        }),
      );
    if (path === '/missing-description')
      return send(response, 200, page(path, 'No description', { description: null }));
    if (path === '/multiple-h1')
      return send(response, 200, page(path, 'Multiple headings', { h1: ['One', 'Two'] }));
    if (path === '/missing-h1')
      return send(response, 200, page(path, 'Missing heading', { h1: [] }));
    if (path === '/noindex')
      return send(response, 200, page(path, 'Noindex content', { robots: 'noindex,follow' }));
    if (path === '/canonical-other')
      return send(
        response,
        200,
        page(path, 'Canonical points elsewhere', { canonical: '/healthy' }),
      );
    if (path === '/broken-source')
      return send(response, 200, page(path, `Broken link <a href="/missing">missing</a>`));
    if (path === '/duplicate-content-a' || path === '/duplicate-content-b')
      return send(
        response,
        200,
        page(path, 'Exactly shared duplicate body content for deterministic hashing.'),
      );
    if (path === '/large') return send(response, 200, page(path, 'large '.repeat(50_000)));
    if (path === '/external')
      return send(response, 200, page(path, '<a href="https://example.org/outside">external</a>'));
    const generatedMatch = /^\/generated\/(\d+)$/.exec(path);
    if (generatedMatch) {
      const current = Number(generatedMatch[1]);
      const next = current < generatedPages ? `<a href="/generated/${current + 1}">next</a>` : '';
      return send(
        response,
        200,
        page(
          path,
          `Generated fixture page ${current} with enough stable words for extraction. ${next}`,
        ),
      );
    }
    const links = [
      '/healthy',
      '/missing-title',
      '/duplicate-title-a',
      '/duplicate-title-b',
      '/missing-description',
      '/multiple-h1',
      '/missing-h1',
      '/noindex',
      '/canonical-other',
      '/broken-source',
      '/redirect-a',
      '/not-found',
      '/server-error',
      '/duplicate-content-a',
      '/duplicate-content-b',
      '/large',
      '/external',
    ]
      .map((item) => `<a href="${item}">${item}</a>`)
      .join('');
    return send(
      response,
      200,
      page('/', `Healthy home content with internal discovery links. ${links}`),
    );
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  return {
    server,
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function send(
  response: import('node:http').ServerResponse,
  status: number,
  body: string,
  type = 'text/html',
) {
  response.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  response.end(body);
}
function redirect(response: import('node:http').ServerResponse, location: string) {
  response.writeHead(301, { location });
  response.end();
}
