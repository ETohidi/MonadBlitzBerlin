export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import QRCode from 'qrcode';

export async function GET(req) {
  const url = new URL(req.url);
  const target = url.searchParams.get('target') ?? new URL('/join', req.url).toString();
  const png = await QRCode.toBuffer(target, { width: 720, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#04070a', light: '#ffffff' } });
  return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
}
