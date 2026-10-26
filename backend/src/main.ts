import { createGateway } from './gateway';
const gateway = createGateway(Number(process.env.SESSION_PORT || 13003));
gateway.once('error', error => { console.error(error); process.exitCode = 1; });
gateway.listen(Number(process.env.PORT || 13002), '127.0.0.1', () => console.log('OpenSpec web gateway ready'));
// Stopping this process deliberately leaves the independent session server running.
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { gateway.close(); gateway.closeAllConnections(); });
