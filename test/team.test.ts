import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handle, type Config, type Deps } from '../src/app.ts';
import { slackUsers, type SuiteLink } from '../src/suite.ts';
import { askedText, digestText, escalatedText, parseAsked, parseDigest, parseEscalated } from '../src/team.ts';
import { pdiSignature } from '../src/waiting.ts';

const PDI = 'pdi-channels-test';
const SUB_ADM = '7badb004-5f2f-4791-838f-9ee86d26839d';
const SUB_NEW = '0c1d2e3f-4a5b-4c6d-8e7f-901234567890';
const LINK: SuiteLink = { issuer: 'https://id.example.com/realms/suite', clientId: 'di-channels', clientSecret: 'secret', identityUrl: 'https://id.example.com' };

const cfg: Config = {
  slackSigningSecret: 'slack',
  slackBotToken: 'xoxb-test',
  definition: { url: 'https://definition.example.com', secret: 'di' },
  workspaces: {},
  waiting: { secret: PDI, approver: 'U0APPROVER', timeZone: 'Europe/Warsaw' },
  suite: LINK,
};

// Monday 2026-11-23, 10:00 in Warsaw — working hours.
const WORKING = new Date('2026-11-23T09:00:00Z');

const asked = (extra: Record<string, unknown> = {}) => ({
  type: 'team.asked',
  id: 'asked-evt-1-1',
  item: 'evt-1',
  summary: 'Prośba o bramkę B2 <b>',
  asked_by: 'Ola Test',
  people: [SUB_ADM, SUB_NEW],
  options: ['approved', 'changes_requested', 'rejected'],
  closes_at: '2026-11-23T13:00:00Z',
  change: 'CHG-1',
  gate: 'B2',
  url: 'http://127.0.0.1:8788/inbox',
  ...extra,
});

const digest = (extra: Record<string, unknown> = {}) => ({
  type: 'team.digest',
  id: 'digest-approver-2026-11-23',
  to: { approver: true },
  day: '2026-11-23',
  waiting: {
    total: 12,
    items: [
      { item: 'evt-1', summary: 'Prośba o bramkę B2', stage: 'overdue', due: '2026-11-20', change: 'CHG-1', gate: 'B2', url: 'http://127.0.0.1:8788/inbox' },
      { item: 'evt-2', summary: 'Plan CHG-2', stage: 'new', due: '2026-11-30', change: 'CHG-2', gate: 'B3' },
    ],
  },
  with_team: [{ item: 'evt-3', summary: 'Zakres R1', answered: 1, asked: 2, closes_at: '2026-11-23T13:00:00Z' }],
  asked_of_you: [],
  to_discuss: { count: 2, url: 'http://127.0.0.1:8788/discuss' },
  unreachable: ['Trzecia Osoba'],
  ...extra,
});

/** Slack and the suite in one fake: e-mails per sub in di-identity, Slack users per e-mail. */
function world(now: Date, opts: { slackDown?: boolean } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const emails: Record<string, string> = { [SUB_ADM]: 'adm@acme.test' };
  const slackIds: Record<string, string> = { 'adm@acme.test': 'U0ADM' };
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const raw = String(init?.body ?? '');
    const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ path: u.hostname === 'slack.com' ? u.pathname.replace('/api/', '') : u.pathname, body });
    if (u.pathname.endsWith('/protocol/openid-connect/token')) return Response.json({ access_token: 'service-token', expires_in: 300 });
    if (u.pathname.startsWith('/api/people/')) {
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer service-token');
      const email = emails[u.pathname.split('/').at(-1)!];
      return email ? Response.json({ sub: 'x', name: 'x', email, organizations: [] }) : Response.json({ error: 'none' }, { status: 404 });
    }
    if (u.hostname === 'slack.com') {
      if (opts.slackDown) return Response.json({ ok: false, error: 'service_unavailable' });
      if (u.pathname === '/api/users.lookupByEmail') {
        const id = slackIds[String(body.email)];
        return Response.json(id ? { ok: true, user: { id } } : { ok: false, error: 'users_not_found' });
      }
      return Response.json({ ok: true, channel: { id: 'D0DM' } });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const deps: Deps = {
    fetch: fakeFetch,
    now: () => now,
    defer: () => undefined,
    log: (m) => void logs.push(m),
    seen: new Set(),
    slackUserOf: slackUsers(LINK, { fetch: fakeFetch, now: () => now, log: (m) => void logs.push(m), slackBotToken: 'xoxb-test' }),
  };
  return { calls, logs, deps };
}

const signed = (path: string, body: unknown, now: Date, secret = PDI) => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(now.getTime() / 1000));
  return { method: 'POST', path, headers: { 'x-pdi-timestamp': ts, 'x-pdi-signature': pdiSignature(secret, ts, raw) }, body: raw };
};

describe('asked of you: "Ask team" in DI Decision (DI Team T6)', () => {
  it('TA-01: each asked person found in Slack gets a direct message; the others are reported, never by e-mail', async () => {
    const w = world(WORKING);
    const res = await handle(signed('/pdi/asked', asked(), WORKING), cfg, w.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { delivered: [{ person: SUB_ADM, status: 'now' }, { person: SUB_NEW, status: 'not_in_slack' }] });
    const lookups = w.calls.filter((c) => c.path === 'users.lookupByEmail');
    assert.deepEqual(lookups.map((c) => c.body.email), ['adm@acme.test']);
    assert.deepEqual(w.calls.find((c) => c.path === 'conversations.open')!.body, { users: 'U0ADM' });
    const text = String(w.calls.find((c) => c.path === 'chat.postMessage')!.body.text);
    assert.match(text, /^\*Ola Test asks for your view\* — CHG-1 · B2\n/);
    assert.match(text, /Prośba o bramkę B2 &lt;b&gt;/);
    assert.match(text, /approved, changes_requested, rejected or talk live/);
    assert.match(text, /closes 14:00 on 2026-11-23/);
    assert.match(text, /<http:\/\/127\.0\.0\.1:8788\/inbox\|Answer in DI Decision>/);
    assert.ok(!w.logs.join('\n').includes('adm@acme.test'), 'the e-mail is never logged');
  });

  it('TA-02: a redelivered message is not sent twice to the same person', async () => {
    const w = world(WORKING);
    await handle(signed('/pdi/asked', asked(), WORKING), cfg, w.deps);
    const again = await handle(signed('/pdi/asked', asked(), WORKING), cfg, w.deps);
    assert.deepEqual(again.body, { delivered: [{ person: SUB_ADM, status: 'duplicate' }, { person: SUB_NEW, status: 'not_in_slack' }] });
    assert.equal(w.calls.filter((c) => c.path === 'chat.postMessage').length, 1);
  });

  it('TA-03: unsigned, malformed or without the suite link it is refused', async () => {
    const w = world(WORKING);
    assert.equal((await handle(signed('/pdi/asked', asked(), WORKING, 'another'), cfg, w.deps)).status, 401);
    assert.equal((await handle(signed('/pdi/asked', asked({ people: ['ola'] }), WORKING), cfg, w.deps)).status, 400);
    const { suite: _, ...noSuite } = cfg;
    assert.equal((await handle(signed('/pdi/asked', asked(), WORKING), noSuite, w.deps)).status, 404);
    assert.equal(w.calls.length, 0);
  });

  it('TA-04: the message checks its fields', () => {
    assert.equal(typeof parseAsked(asked()), 'object');
    assert.match(String(parseAsked(asked({ people: [] }))), /people/);
    assert.match(String(parseAsked(asked({ closes_at: 'tomorrow' }))), /closes_at/);
    assert.match(String(parseAsked(asked({ url: 'http://127.0.0.1:8788/inbox?t=secret' }))), /url/);
    assert.match(String(parseAsked(asked({ type: 'gate.waiting' }))), /type/);
    const a = parseAsked(asked({ change: undefined, gate: undefined, url: undefined }));
    assert.ok(typeof a === 'object');
    assert.match(askedText(a, 'Europe/Warsaw'), /Answer in DI Decision/);
  });
});

describe('the daily digest (DI Team T6)', () => {
  it('TD-01: the approver gets one message: waiting, with the team, to discuss, who is not reachable', async () => {
    const w = world(WORKING);
    const res = await handle(signed('/pdi/digest', digest(), WORKING), cfg, w.deps);
    assert.deepEqual(res.body, { delivered: 'now' });
    assert.deepEqual(w.calls.find((c) => c.path === 'conversations.open')!.body, { users: 'U0APPROVER' });
    const text = String(w.calls.find((c) => c.path === 'chat.postMessage')!.body.text);
    assert.match(text, /^\*Your day in DI Decision — 2026-11-23\*/);
    assert.match(text, /\*Waiting for your decision \(12\)\*/);
    assert.match(text, /• Overdue — CHG-1 · B2: Prośba o bramkę B2 \(was due 2026-11-20\) <http:\/\/127\.0\.0\.1:8788\/inbox\|Decide>/);
    assert.match(text, /• CHG-2 · B3: Plan CHG-2 \(due 2026-11-30\)/);
    assert.match(text, /…and 10 more/);
    assert.match(text, /\*With the team \(1\)\*\n• Zakres R1: 1 of 2 answered, closes 14:00 on 2026-11-23/);
    assert.match(text, /\*To discuss: 2\* <http:\/\/127\.0\.0\.1:8788\/discuss\|Open the agenda>/);
    assert.match(text, /Not reachable in Slack: Trzecia Osoba/);
  });

  it('TD-02: a person\'s digest goes to them through the suite; before 8:00 Slack holds it', async () => {
    const early = new Date('2026-11-23T06:55:00Z'); // 7:55 in Warsaw
    const w = world(early);
    const body = digest({
      id: `digest-${SUB_ADM}-2026-11-23`,
      to: { person: SUB_ADM },
      waiting: { total: 0, items: [] },
      with_team: [],
      to_discuss: { count: 0 },
      unreachable: [],
      asked_of_you: [{ item: 'evt-1', summary: 'Prośba o bramkę B2', asked_by: 'Ola Test', closes_at: '2026-11-23T13:00:00Z', url: 'http://127.0.0.1:8788/inbox' }],
    });
    const res = await handle(signed('/pdi/digest', body, early), cfg, w.deps);
    assert.deepEqual(res.body, { delivered: 'scheduled', at: '2026-11-23T07:00:00.000Z' });
    assert.deepEqual(w.calls.find((c) => c.path === 'conversations.open')!.body, { users: 'U0ADM' });
    const text = String(w.calls.find((c) => c.path === 'chat.scheduleMessage')!.body.text);
    assert.match(text, /\*Asked of you \(1\)\*\n• Ola Test asks: Prośba o bramkę B2 — closes 14:00 on 2026-11-23 <http:\/\/127\.0\.0\.1:8788\/inbox\|Answer>/);
    assert.doesNotMatch(text, /Waiting for your decision/);
  });

  it('TD-03: an empty digest sends nothing; a repeated one is a duplicate; an unknown person is reported', async () => {
    const w = world(WORKING);
    const empty = digest({ waiting: { total: 0, items: [] }, with_team: [], to_discuss: { count: 0 }, unreachable: [] });
    assert.deepEqual((await handle(signed('/pdi/digest', empty, WORKING), cfg, w.deps)).body, { delivered: 'empty' });
    assert.equal(w.calls.length, 0);
    await handle(signed('/pdi/digest', digest(), WORKING), cfg, w.deps);
    assert.deepEqual((await handle(signed('/pdi/digest', digest(), WORKING), cfg, w.deps)).body, { delivered: 'duplicate' });
    const stranger = digest({ id: `digest-${SUB_NEW}-2026-11-23`, to: { person: SUB_NEW } });
    const res = await handle(signed('/pdi/digest', stranger, WORKING), cfg, w.deps);
    assert.deepEqual(res.body, { delivered: 'not_in_slack' });
  });

  it('TD-04: Slack failing is a 502, so pdi can try again', async () => {
    const w = world(WORKING, { slackDown: true });
    assert.equal((await handle(signed('/pdi/digest', digest(), WORKING), cfg, w.deps)).status, 502);
  });

  it('TD-05: the digest checks its fields and keeps lists short', () => {
    assert.equal(typeof parseDigest(digest()), 'object');
    assert.match(String(parseDigest(digest({ to: {} }))), /to/);
    assert.match(String(parseDigest(digest({ to: { person: 'ola' } }))), /to/);
    assert.match(String(parseDigest(digest({ day: '23.11.2026' }))), /day/);
    const many = Array.from({ length: 11 }, (_, i) => ({ item: `e${i}`, summary: 's', stage: 'new', due: '2026-11-30' }));
    assert.match(String(parseDigest(digest({ waiting: { total: 11, items: many } }))), /waiting/);
    const d = parseDigest(digest());
    assert.ok(typeof d === 'object');
    assert.ok(digestText(d, 'Europe/Warsaw').length < 3500);
  });
});

const escalated = (extra: Record<string, unknown> = {}) => ({
  type: 'team.escalated',
  id: 'escalated-evt-1-2026-11-23T09:00:00Z',
  item: 'evt-1',
  summary: 'Prośba o bramkę B5',
  by: 'Ola Test',
  to: SUB_ADM,
  reason: 'Wydanie dotyka płatności <b>',
  due: '2026-11-24',
  change: 'CHG-1',
  gate: 'B5',
  url: 'http://127.0.0.1:8788/inbox',
  ...extra,
});

describe('escalated to you: "Escalate" in DI Decision (DI Team T7)', () => {
  it('TE-01: the addressee gets a direct message that the decision is now theirs', async () => {
    const w = world(WORKING);
    const res = await handle(signed('/pdi/escalated', escalated(), WORKING), cfg, w.deps);
    assert.deepEqual(res.body, { delivered: 'now' });
    assert.deepEqual(w.calls.find((c) => c.path === 'conversations.open')!.body, { users: 'U0ADM' });
    const text = String(w.calls.find((c) => c.path === 'chat.postMessage')!.body.text);
    assert.match(text, /^\*Ola Test escalated a decision to you\* — CHG-1 · B5\n/);
    assert.match(text, /Why: Wydanie dotyka płatności &lt;b&gt;/);
    assert.match(text, /You decide now\. Due 2026-11-24\. <http:\/\/127\.0\.0\.1:8788\/inbox\|Decide in DI Decision>/);
  });

  it('TE-02: an addressee missing from Slack is reported; a redelivery is a duplicate; a bad body is refused', async () => {
    const w = world(WORKING);
    assert.deepEqual((await handle(signed('/pdi/escalated', escalated({ to: SUB_NEW }), WORKING), cfg, w.deps)).body, { delivered: 'not_in_slack' });
    await handle(signed('/pdi/escalated', escalated(), WORKING), cfg, w.deps);
    assert.deepEqual((await handle(signed('/pdi/escalated', escalated(), WORKING), cfg, w.deps)).body, { delivered: 'duplicate' });
    assert.equal((await handle(signed('/pdi/escalated', escalated({ reason: '' }), WORKING), cfg, w.deps)).status, 400);
    assert.equal((await handle(signed('/pdi/escalated', escalated({ to: 'ola' }), WORKING), cfg, w.deps)).status, 400);
    const { suite: _, ...noSuite } = cfg;
    assert.equal((await handle(signed('/pdi/escalated', escalated(), WORKING), noSuite, w.deps)).status, 404);
  });

  it('TE-03: the digest has "Escalated to you" and a digest with only that is not empty', async () => {
    const w = world(WORKING);
    const body = digest({
      id: `digest-${SUB_ADM}-2026-11-23`,
      to: { person: SUB_ADM },
      waiting: { total: 0, items: [] },
      with_team: [],
      to_discuss: { count: 0 },
      unreachable: [],
      escalated_to_you: [{ item: 'evt-1', summary: 'Prośba o bramkę B5', by: 'Ola Test', due: '2026-11-24', url: 'http://127.0.0.1:8788/inbox' }],
    });
    assert.deepEqual((await handle(signed('/pdi/digest', body, WORKING), cfg, w.deps)).body, { delivered: 'now' });
    const text = String(w.calls.find((c) => c.path === 'chat.postMessage')!.body.text);
    assert.match(text, /\*Escalated to you \(1\)\*\n• Ola Test: Prośba o bramkę B5 \(due 2026-11-24\) <http:\/\/127\.0\.0\.1:8788\/inbox\|Decide>/);
    assert.match(String(parseDigest(digest({ escalated_to_you: [{ item: 'x' }] }))), /escalated_to_you/);
    assert.match(String(parseEscalated(escalated({ due: 'soon' }))), /due/);
    const e = parseEscalated(escalated());
    assert.ok(typeof e === 'object');
    assert.match(escalatedText(e), /Decide in DI Decision/);
  });
});
