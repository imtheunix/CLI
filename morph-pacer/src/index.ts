import { RealClock } from './clock.js';
import { loadConfig } from './config.js';
import { consoleLogger } from './logger.js';
import { createProxyServer } from './proxy.js';

const config = loadConfig();
const server = createProxyServer({ config, clock: new RealClock(), logger: consoleLogger });

server.listen(config.port, config.host, () => {
  consoleLogger.info(`morph-pacer listening on http://${config.host}:${config.port}`);
});

function shutdown(signal: string): void {
  consoleLogger.info(`morph-pacer: ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
