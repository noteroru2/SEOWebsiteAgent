import { NextResponse } from 'next/server';
import { ingestOwnerAssistedCapture } from '@seo-agent/database';
import {
  assistedCapturePayloadSchema,
  assistedCapturePayloadWithinBounds,
  ASSISTED_CAPTURE_MAX_BYTES,
  isAllowedGoogleOrigin,
} from '@seo-agent/serp-capture';

const corsHeaders = (origin: string) => ({
  'Access-Control-Allow-Origin': origin,
  Vary: 'Origin',
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  if (!isAllowedGoogleOrigin(origin)) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin!),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    },
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (!isAllowedGoogleOrigin(origin))
    return NextResponse.json({ error: 'Google SERP origin required' }, { status: 403 });
  const headers = corsHeaders(origin!);
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > ASSISTED_CAPTURE_MAX_BYTES)
    return NextResponse.json({ error: 'Capture payload is too large' }, { status: 413, headers });
  try {
    const raw = await request.text();
    if (!assistedCapturePayloadWithinBounds(raw))
      return NextResponse.json({ error: 'Capture payload is too large' }, { status: 413, headers });
    const payload = assistedCapturePayloadSchema.parse(JSON.parse(raw));
    const capture = await ingestOwnerAssistedCapture(payload);
    return NextResponse.json({ captured: true, captureId: capture.id }, { headers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Capture rejected' },
      { status: 400, headers },
    );
  }
}
