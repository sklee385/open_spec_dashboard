import { createServer, type Server } from 'node:net';
import { mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
export async function acquireDataOwnership(directory: string): Promise<Server> {
  mkdirSync(directory, { recursive: true });
  const canonical = process.platform === 'win32' ? realpathSync(directory).toLowerCase() : realpathSync(directory);
  // OS socket ownership survives parent failure and is released automatically if the owner exits.
  // A hash collision with another app fails closed; never steal or pick a second lock slot.
  const port = 30000 + createHash('sha256').update(canonical).digest().readUInt32BE(0) % 19000;
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('이 데이터의 대화 서버가 이미 실행 중이거나 소유 잠금 포트를 사용할 수 없습니다. 기존 프로세스를 확인해 주세요.')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return server;
}
