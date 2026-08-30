import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  enqueueManualOpportunityWatch,
  manualCommandSnapshot,
  manualRunStatus,
} from '@seo-agent/database';

export const dynamic = 'force-dynamic';

const requestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ALL') }).strict(),
  z.object({ mode: z.literal('SITE'), siteId: z.string().uuid() }).strict(),
]);

function localCommandsEnabled() {
  return process.env.LOCAL_MANUAL_COMMANDS_ENABLED === 'true';
}

export async function POST(request: NextRequest) {
  if (!localCommandsEnabled())
    return NextResponse.json({ code: 'LOCAL_COMMANDS_DISABLED' }, { status: 403 });

  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ code: 'INVALID_REQUEST' }, { status: 400 });
  }

  const readiness = await manualCommandSnapshot();
  if (!readiness.worker.healthy)
    return NextResponse.json({ code: 'WORKER_UNAVAILABLE', readiness }, { status: 409 });
  if (!readiness.executor.ready)
    return NextResponse.json({ code: readiness.executor.status, readiness }, { status: 409 });
  if (readiness.eligibleSites === 0)
    return NextResponse.json({ code: 'NO_ELIGIBLE_SITE', readiness }, { status: 409 });

  try {
    const result = await enqueueManualOpportunityWatch(input);
    return NextResponse.json({ ok: true, ...result }, { status: 202 });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'SITE_NOT_FOUND')
      return NextResponse.json({ code: 'SITE_NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ code: 'ENQUEUE_FAILED' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  if (!localCommandsEnabled())
    return NextResponse.json({ code: 'LOCAL_COMMANDS_DISABLED' }, { status: 403 });
  const runId = request.nextUrl.searchParams.get('runId');
  if (!runId || !z.string().uuid().safeParse(runId).success)
    return NextResponse.json({ code: 'INVALID_RUN_ID' }, { status: 400 });
  return NextResponse.json(await manualRunStatus(runId));
}
