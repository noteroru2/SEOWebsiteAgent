import { NextResponse } from 'next/server';
import { createGscOAuthState, getSite } from '@seo-agent/database';
import { createOAuthState, googleOAuthUrl, requireGoogleConfig } from '@seo-agent/gsc';

export async function GET(request: Request) {
  try {
    const siteId = new URL(request.url).searchParams.get('siteId') ?? '';
    if (!siteId || !(await getSite(siteId)))
      return new NextResponse('Invalid site', { status: 400 });
    const config = requireGoogleConfig();
    const state = createOAuthState();
    await createGscOAuthState(siteId, state.hash);
    return NextResponse.redirect(
      googleOAuthUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state: state.value,
      }),
    );
  } catch {
    return new NextResponse('Google connection is not configured', { status: 503 });
  }
}
