export function GET(request: Request) {
  return Response.redirect(new URL('/api/health/ready', request.url), 307);
}
