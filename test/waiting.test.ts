import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handle, type Config, type Deps } from '../src/app.ts';
import { configFrom } from '../src/config.ts';
import { deliverAt, parseWaiting, pdiSignature, waitingText } from '../src/waiting.ts';

const PDI = 'pdi-channels-test';
const TZ = 'Europe/Warsaw';

const cfg: Config = {
  slackSigningSecret: 'slack',
  slackBotToken: 'xoxb-test',
  definition: { url: 'https://definition.example.com', secret: 'di' },
  workspaces: {},
  waiting: { secret: PDI, approver: 'U0APPROVER', timeZone: TZ },
};

const message = (extra: Record<string, unknown> = {}) => ({
  id: 'waiting-evt-gate-1',
  type: 'gate.waiting',
  source: 'pdi',
  item: 'evt-gate-1',
  kind: 'gate',
  summary: 'Plan for CHG-12 is ready <b>',
  received_at: '2026-11-23T09:00:00Z',
  due: '2026-11-30',
  business_days: 5,
  where: 'sdlc open → Skrzynka',
  change: 'CHG-12',
  gate: 'B3',
  ...extra,
});

function world(now: Date, slack: (method: string) => unknown = () => ({ ok: true, channel: { id: 'D0DM' } })) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace('https://slack.com/api/', '');
    calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(slack(method)), { status: 200 });
  }) as typeof fetch;
  const deps: Deps = { fetch: fakeFetch, now: () => now, defer: () => undefined, log: (m) => void logs.push(m), seen: new Set() };
  return { calls, logs, deps };
}

const signed = (body: unknown, now: Date, secret = PDI) => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(now.getTime() / 1000));
  return { method: 'POST', path: '/pdi/waiting', headers: { 'x-pdi-timestamp': ts, 'x-pdi-signature': pdiSignature(secret, ts, raw) }, body: raw };
};

// Monday 2026-11-23, 10:00 in Warsaw (UTC+1) — working hours.
const WORKING = new Date('2026-11-23T09:00:00Z');

describe('waiting for you (step 17)', () => {
  it('WT-01: in working hours the approver gets a direct message now', async () => {
    const w = world(WORKING);
    const res = await handle(signed(message(), WORKING), cfg, w.deps);
    assert.deepEqual(res.body, { delivered: 'now' });
    assert.deepEqual(w.calls.map((c) => c.method), ['conversations.open', 'chat.postMessage']);
    assert.deepEqual(w.calls[0]!.body, { users: 'U0APPROVER' });
    assert.equal(w.calls[1]!.body.channel, 'D0DM');
    assert.match(String(w.calls[1]!.body.text), /Waiting for your decision\* — CHG-12 · B3/);
    assert.match(String(w.calls[1]!.body.text), /Due 2026-11-30 \(5 working days\)/);
  });

  it('WT-02: in quiet hours Slack holds the message until 8:00 of the next working day', async () => {
    const friday = new Date('2026-11-27T19:30:00Z'); // Friday 20:30 in Warsaw
    const w = world(friday);
    const res = await handle(signed(message(), friday), cfg, w.deps);
    assert.deepEqual(res.body, { delivered: 'scheduled', at: '2026-11-30T07:00:00.000Z' }); // Monday 8:00 Warsaw
    assert.equal(w.calls[1]!.method, 'chat.scheduleMessage');
    assert.equal(w.calls[1]!.body.post_at, Date.parse('2026-11-30T07:00:00Z') / 1000);
  });

  it('WT-03: a redelivered message is not sent twice', async () => {
    const w = world(WORKING);
    await handle(signed(message(), WORKING), cfg, w.deps);
    const again = await handle(signed(message(), WORKING), cfg, w.deps);
    assert.deepEqual(again.body, { delivered: 'duplicate' });
    assert.equal(w.calls.length, 2);
  });

  it('WT-04: unsigned, wrongly signed or a bad body is refused; nothing goes to Slack', async () => {
    const w = world(WORKING);
    assert.equal((await handle({ method: 'POST', path: '/pdi/waiting', headers: {}, body: '{}' }, cfg, w.deps)).status, 401);
    assert.equal((await handle(signed(message(), WORKING, 'other'), cfg, w.deps)).status, 401);
    assert.equal((await handle(signed(message({ type: 'x' }), WORKING), cfg, w.deps)).status, 400);
    assert.equal((await handle(signed(message({ url: 'http://127.0.0.1:8788/inbox/x?t=secret' }), WORKING), cfg, w.deps)).status, 400);
    assert.equal(w.calls.length, 0);
  });

  it('WT-05: Slack refusing is a 502, so pdi records the failure', async () => {
    const w = world(WORKING, (m) => (m === 'conversations.open' ? { ok: true, channel: { id: 'D0DM' } } : { ok: false, error: 'missing_scope' }));
    const res = await handle(signed(message(), WORKING), cfg, w.deps);
    assert.equal(res.status, 502);
    assert.match(w.logs.join('\n'), /missing_scope/);
    assert.ok(!w.logs.join('\n').includes('Plan for CHG-12'), 'the log never carries the summary');
  });

  it('WT-06: without the waiting settings the route does not exist', async () => {
    const w = world(WORKING);
    const { waiting: _, ...off } = cfg;
    assert.equal((await handle(signed(message(), WORKING), off, w.deps)).status, 404);
  });

  it('WT-07: quiet hours, weekends and the time zone', () => {
    assert.equal(deliverAt(new Date('2026-11-23T06:30:00Z'), TZ)?.toISOString(), '2026-11-23T07:00:00.000Z'); // Mon 7:30 → 8:00 same day
    assert.equal(deliverAt(new Date('2026-11-23T16:59:00Z'), TZ), null); // Mon 17:59 → now
    assert.equal(deliverAt(new Date('2026-11-23T17:00:00Z'), TZ)?.toISOString(), '2026-11-24T07:00:00.000Z'); // Mon 18:00 → Tue 8:00
    assert.equal(deliverAt(new Date('2026-11-28T10:00:00Z'), TZ)?.toISOString(), '2026-11-30T07:00:00.000Z'); // Sat → Mon
    assert.equal(deliverAt(new Date('2026-07-04T10:00:00Z'), TZ)?.toISOString(), '2026-07-06T06:00:00.000Z'); // summer time: UTC+2
  });

  it('WT-08: text is escaped for Slack and a stage gate reads as flag → stage', () => {
    const w = parseWaiting(message({ gate: 'stage:payment-retry:prod', business_days: 1 }));
    assert.ok(typeof w !== 'string');
    const text = waitingText(w);
    assert.match(text, /CHG-12 · payment-retry → prod/);
    assert.match(text, /&lt;b&gt;/);
    assert.match(text, /1 working day\)/);
    assert.match(text, /`sdlc open → Skrzynka`/);
    const linked = parseWaiting(message({ url: 'https://pdi.example.com/inbox/evt-gate-1' }));
    assert.ok(typeof linked !== 'string');
    assert.match(waitingText(linked), /<https:\/\/pdi\.example\.com\/inbox\/evt-gate-1\|Decide in DI Decision>/);
  });

  it('WT-09: configuration needs the secret and the approver together', () => {
    const base = { SLACK_SIGNING_SECRET: 's', SLACK_BOT_TOKEN: 'xoxb-1', CI_CHANNELS_SIGNING_SECRET: 'c', DI_DEFINITION_URL: 'https://ci.example.com' };
    assert.equal(configFrom(base).waiting, undefined);
    assert.deepEqual(configFrom({ ...base, PDI_CHANNELS_SIGNING_SECRET: 'p', DI_CHANNELS_APPROVER: 'U0ABC' }).waiting, { secret: 'p', approver: 'U0ABC', timeZone: 'Europe/Warsaw' });
    assert.throws(() => configFrom({ ...base, PDI_CHANNELS_SIGNING_SECRET: 'p' }), /go together/);
    assert.throws(() => configFrom({ ...base, PDI_CHANNELS_SIGNING_SECRET: 'p', DI_CHANNELS_APPROVER: 'ola' }), /Slack user id/);
    assert.throws(() => configFrom({ ...base, PDI_CHANNELS_SIGNING_SECRET: 'p', DI_CHANNELS_APPROVER: 'U0ABC', DI_CHANNELS_TIMEZONE: 'Mars/Base' }), /time zone/);
  });
});
