import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handle, type Config, type Deps } from '../src/app.ts';
import { configFrom } from '../src/config.ts';
import { slackSignature } from '../src/slack.ts';
import { suitePeople, within, type SuiteLink } from '../src/suite.ts';

const LINK: SuiteLink = { issuer: 'https://id.example.com/realms/suite', clientId: 'di-channels', clientSecret: 'secret', identityUrl: 'https://id.example.com' };
const SUB = '7badb004-5f2f-4791-838f-9ee86d26839d';
let clock = new Date('2026-11-23T12:00:00Z');

/** Slack, Keycloak and di-identity in one fake; `calls` counts requests per host+path. */
function suiteWorld(opts: { email?: string | null; identity?: number; slackError?: string } = {}) {
  const calls: string[] = [];
  const bodies: string[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    bodies.push(String(init?.body ?? ''));
    if (u.hostname === 'slack.com') {
      if (opts.slackError) return Response.json({ ok: false, error: opts.slackError });
      return Response.json({ ok: true, user: { profile: opts.email === null ? {} : { email: opts.email ?? 'Ola@Acme.com' } } });
    }
    if (u.pathname.endsWith('/protocol/openid-connect/token')) return Response.json({ access_token: 'service-token', expires_in: 300 });
    if (u.pathname === '/api/people') {
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer service-token');
      assert.equal(u.searchParams.get('email'), 'ola@acme.com');
      return opts.identity === 404 ? Response.json({ error: 'none' }, { status: 404 }) : opts.identity ? new Response('', { status: opts.identity }) : Response.json({ sub: SUB, name: 'Ola Nowak', organizations: ['acme'] });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const logs: string[] = [];
  const find = suitePeople(LINK, { fetch: fakeFetch, now: () => clock, log: (m) => void logs.push(m), slackBotToken: 'xoxb-test' });
  return { find, calls, bodies, logs };
}

describe('the suite person behind a Slack user', () => {
  it('SU-01: Slack e-mail → di-identity with the service token → sub and suite name; cached', async () => {
    const w = suiteWorld();
    assert.deepEqual(await w.find('U012AB3CD'), { sub: SUB, name: 'Ola Nowak' });
    assert.deepEqual(await w.find('U012AB3CD'), { sub: SUB, name: 'Ola Nowak' });
    assert.deepEqual(w.calls, ['/api/users.info', '/realms/suite/protocol/openid-connect/token', '/api/people']);
    assert.match(w.bodies[1] ?? '', /grant_type=client_credentials&client_id=di-channels&client_secret=secret/);
  });

  it('SU-02: no match, no e-mail, Slack or di-identity errors give null, never throw, never log the e-mail', async () => {
    assert.equal(await suiteWorld({ identity: 404 }).find('U1'), null);
    assert.equal(await suiteWorld({ email: null }).find('U1'), null);
    const failing = suiteWorld({ identity: 500 });
    assert.equal(await failing.find('U1'), null);
    const missingScope = suiteWorld({ slackError: 'missing_scope' });
    assert.equal(await missingScope.find('U1'), null);
    assert.match(missingScope.logs.join('\n'), /users.info: missing_scope/);
    assert.ok(![...failing.logs, ...missingScope.logs].some((l) => /acme\.com/i.test(l)));
  });

  it('SU-03: a missing match is retried after 10 minutes, a found person after an hour', async () => {
    const w = suiteWorld({ identity: 404 });
    await w.find('U1');
    await w.find('U1');
    assert.equal(w.calls.filter((c) => c === '/api/people').length, 1);
    clock = new Date(clock.getTime() + 11 * 60 * 1000);
    await w.find('U1');
    assert.equal(w.calls.filter((c) => c === '/api/people').length, 2);
  });

  it('SU-04: within gives up with null when the suite is slow', async () => {
    const slow = async () => new Promise<{ sub: string; name: string }>((r) => setTimeout(() => r({ sub: SUB, name: 'x' }), 200));
    assert.equal(await within(slow, 20)('U1'), null);
  });

  it('SU-05: the setting is all three or none', () => {
    const base = { SLACK_SIGNING_SECRET: 's', SLACK_BOT_TOKEN: 'b', CI_CHANNELS_SIGNING_SECRET: 'c', DI_DEFINITION_URL: 'https://def.example.com' };
    assert.equal(configFrom(base).suite, undefined);
    assert.throws(() => configFrom({ ...base, SUITE_ISSUER: 'https://id.example.com/realms/suite' }), /go together/);
    assert.throws(() => configFrom({ ...base, SUITE_ISSUER: 'http://id.example.com/realms/suite', SUITE_CLIENT_SECRET: 'x', DI_IDENTITY_URL: 'https://id.example.com' }), /SUITE_ISSUER must be https/);
    assert.deepEqual(configFrom({ ...base, SUITE_ISSUER: 'http://localhost:8180/realms/suite/', SUITE_CLIENT_SECRET: 'x', DI_IDENTITY_URL: 'http://localhost:3000' }).suite, {
      issuer: 'http://localhost:8180/realms/suite',
      clientId: 'di-channels',
      clientSecret: 'x',
      identityUrl: 'http://localhost:3000',
    });
  });
});

describe('questions with the suite person as author', () => {
  const cfg: Config = { slackSigningSecret: 'sig', slackBotToken: 'xoxb-test', definition: { url: 'https://definition.example.com', secret: 'di' }, workspaces: {} };
  const ts = String(Math.floor(Date.now() / 1000));

  it('SU-06: /di-question sends author.suite_id and the suite name when the person is found', async () => {
    const sent: { url: string; body: string }[] = [];
    const deferred: Promise<unknown>[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? '') });
      return String(url).startsWith('https://definition.example.com/') ? Response.json({ question: { id: 'hq-1' }, duplicate: false }) : Response.json({ ok: true });
    }) as typeof fetch;
    const deps: Deps = { fetch: fakeFetch, now: () => new Date(), defer: (w) => void deferred.push(w), log: () => {}, suitePerson: async () => ({ sub: SUB, name: 'Ola Nowak' }) };
    const body = new URLSearchParams({ team_id: 'T1', channel_id: 'C1', user_id: 'U012AB3CD', user_name: 'ola', text: 'PAY-1 Why?', response_url: 'https://hooks.slack.com/commands/T1/1/a', trigger_id: '1.2.3' }).toString();
    const res = await handle({ method: 'POST', path: '/slack/commands', headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature('sig', ts, body) }, body }, cfg, deps);
    assert.equal(res.status, 200);
    await Promise.all(deferred);
    const toDefinition = JSON.parse(sent.find((s) => s.url.startsWith('https://definition.example.com/'))!.body);
    assert.deepEqual(toDefinition.author, { name: 'Ola Nowak', user: 'U012AB3CD', suite_id: SUB });
  });
});
