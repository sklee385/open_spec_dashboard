import { createApplication } from './app';
async function main() {
  const app = await createApplication();
  try {
    await app.listen(Number(process.env.SESSION_PORT || 13003), '127.0.0.1');
    console.log(`OpenSpec session server: ${await app.getUrl()}`);
  } catch (error) { await app.close(); throw error; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
