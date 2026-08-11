import { startFixture } from './fixture-server';

async function main() {
  const fixture = await startFixture(
    Number(process.env.FIXTURE_PAGES ?? 500),
    Number(process.env.FIXTURE_PORT ?? 4178),
  );
  console.log(`SEO fixture listening at ${fixture.baseUrl}`);
  const close = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
void main();
