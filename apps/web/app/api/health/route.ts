import { databaseHealthy, productionHealthSnapshot } from '@seo-agent/database';

export async function GET(request: Request) {
  const database = await databaseHealthy();
  const scope = new URL(request.url).searchParams.get('scope');
  if (scope === 'live') {
    return Response.json(
      {
        status: database ? 'ok' : 'failed',
        database,
        gitSha: process.env.APP_GIT_SHA || 'unknown',
      },
      { status: database ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!database) {
    return Response.json(
      { status: 'FAILED', database: false, gitSha: process.env.APP_GIT_SHA || 'unknown' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const health = await productionHealthSnapshot();
    const status = health.status === 'HEALTHY' ? 200 : 503;
    return Response.json(
      { ...health, database: true },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      {
        status: 'FAILED',
        database: true,
        detailAvailable: false,
        gitSha: process.env.APP_GIT_SHA || 'unknown',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
