import { createServer } from 'node:http';
import { handle, type Response } from './app.ts';
import { configFrom } from './config.ts';
import { suitePeople } from './suite.ts';

const MAX_BODY = 64 * 1024;

const cfg = configFrom(process.env);
const seen = new Set<string>();
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const suitePerson = cfg.suite && suitePeople(cfg.suite, { fetch, now: () => new Date(), log, slackBotToken: cfg.slackBotToken });
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on('end', async () => {
    const started = Date.now();
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const out = await handle({ method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0]!, headers, body: Buffer.concat(chunks).toString('utf8') }, cfg, {
      fetch,
      now: () => new Date(),
      defer: (work) => void work.catch((e: unknown) => log(`after-reply work failed: ${e instanceof Error ? e.message : 'unknown error'}`)),
      log,
      seen,
      ...(suitePerson && { suitePerson }),
    }).catch((e: unknown) => {
      log(`request failed: ${e instanceof Error ? e.message : 'unknown error'}`);
      return { status: 500 } as Response;
    });
    log(`${req.method} ${(req.url ?? '/').split('?')[0]} → ${out.status} (${Date.now() - started} ms)`);
    res.writeHead(out.status, out.body === undefined ? {} : { 'content-type': 'application/json' });
    res.end(out.body === undefined ? '' : JSON.stringify(out.body));
  });
});
const port = Number(process.env.PORT ?? 3100);
server.listen(port, () => {
  log(`di-channels on :${port}`);
  log(cfg.suite ? `suite person as author: on (di-identity ${cfg.suite.identityUrl})` : 'suite person as author: off (set SUITE_ISSUER, SUITE_CLIENT_SECRET and DI_IDENTITY_URL)');
});
