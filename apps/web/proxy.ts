import { NextRequest, NextResponse } from 'next/server';
import { ownerAuthConfig, validOwnerBasicAuthorization } from './lib/owner-auth';

export function proxy(request: NextRequest) {
  const config = ownerAuthConfig();
  if (config.required && (!config.username || !config.password)) {
    return new NextResponse('Owner authentication is not configured.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }

  if (!validOwnerBasicAuthorization(request.headers.get('authorization'), config)) {
    return new NextResponse('Authentication required.', {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Basic realm="SEO Website Agent", charset="UTF-8"',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  }

  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const config = {
  matcher: ['/((?!api/health|_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
