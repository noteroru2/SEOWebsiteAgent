import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { getDatabase } from '@seo-agent/database';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const { pool } = getDatabase();
  const result = await pool.query(
    `SELECT screenshot_path FROM serp_captures WHERE id=$1 AND screenshot_path IS NOT NULL`,
    [id],
  );
  if (!result.rows[0]) return new Response('Not found', { status: 404 });
  const file = join('/app/artifacts/serp', basename(String(result.rows[0].screenshot_path)));
  try {
    return new Response(await readFile(/* turbopackIgnore: true */ file), {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=60' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
