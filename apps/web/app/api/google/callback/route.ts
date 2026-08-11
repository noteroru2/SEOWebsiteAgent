import { NextResponse } from 'next/server';
import { consumeGscOAuthState, saveGscConnection } from '@seo-agent/database';
import {
  encryptSecret,
  exchangeGoogleCode,
  GoogleSearchConsoleApi,
  hashOAuthState,
  oauthCompletionUrl,
  GSC_READONLY_SCOPE,
} from '@seo-agent/gsc';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new NextResponse('Invalid OAuth callback', { status: 400 });
  const savedState = await consumeGscOAuthState(hashOAuthState(state));
  if (!savedState) return new NextResponse('OAuth state mismatch or expired', { status: 400 });
  try {
    const tokens = await exchangeGoogleCode(code);
    if (!tokens.refresh_token) throw new Error('Google did not return an offline refresh token');
    if (!tokens.scope.split(' ').includes(GSC_READONLY_SCOPE))
      throw new Error('Required read-only scope was not granted');
    const properties = await new GoogleSearchConsoleApi(tokens.access_token).listProperties();
    await saveGscConnection({
      siteId: savedState.siteId,
      encryptedRefreshToken: encryptSecret(tokens.refresh_token),
      encryptedAccessToken: encryptSecret(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      scope: GSC_READONLY_SCOPE,
      properties,
    });
    return NextResponse.redirect(oauthCompletionUrl(savedState.siteId, 'success'));
  } catch {
    return NextResponse.redirect(oauthCompletionUrl(savedState.siteId, 'error'));
  }
}
