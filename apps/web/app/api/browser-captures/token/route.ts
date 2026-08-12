import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createBrowserCaptureToken } from '@seo-agent/database';
import { createOwnerAssistedBookmarklet } from '@seo-agent/serp-capture';

const inputSchema = z
  .object({
    opportunityId: z.string().uuid(),
    requestId: z.string().uuid(),
    ownerDeclaredLocation: z.string().min(1).max(200),
  })
  .strict();

function localRequest(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.origin === new URL(request.url).origin
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!localRequest(request))
    return NextResponse.json({ error: 'Local origin required' }, { status: 403 });
  try {
    const input = inputSchema.parse(await request.json());
    const grant = await createBrowserCaptureToken(input);
    const endpoint = new URL('/api/browser-captures/ingest', request.url).toString();
    return NextResponse.json({
      bookmarklet: createOwnerAssistedBookmarklet({ endpoint, ...grant }),
      expiresAt: grant.expiresAt.toISOString(),
      query: grant.expectedQuery,
      targetDomain: grant.targetDomain,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Capture tool could not be created' },
      { status: 400 },
    );
  }
}
