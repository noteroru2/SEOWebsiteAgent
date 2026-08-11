import { databaseHealthy } from '@seo-agent/database';
export async function GET() {
  const database = await databaseHealthy();
  return Response.json(
    { status: database ? 'ok' : 'degraded', database },
    { status: database ? 200 : 503 },
  );
}
