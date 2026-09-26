export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A fixed-size payload so downlink can be timed from the page itself.
export async function GET(req) {
  const big = new URL(req.url).searchParams.get('big');
  const bytes = big ? 200_000 : 8;
  const body = new Uint8Array(bytes);
  return new Response(body, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-groundtruth': 'ping',
    },
  });
}
