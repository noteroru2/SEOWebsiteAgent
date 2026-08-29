import { databaseHealthy, productionHealthSnapshot } from '@seo-agent/database';

export async function GET() {
  const database = await databaseHealthy();
  if (!database) {
    return Response.json(
      { status: 'FAILED', database: false },
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
      { status: 'FAILED', database: true, detailAvailable: false },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
