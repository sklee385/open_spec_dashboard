import { createApplication } from './app';
async function main() {
  const app = await createApplication();
  await app.listen(Number(process.env.PORT || 13002), '127.0.0.1');
  console.log(`OpenSpec NestJS: ${await app.getUrl()}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
