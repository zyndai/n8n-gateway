// For the container health check. No secrets, no data.
export function GET() {
  return Response.json({ ok: true });
}
