import { cleanupExpiredDrawings } from '../lib/crayon.js';

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  await cleanupExpiredDrawings();
  return Response.json({ ok: true });
}

