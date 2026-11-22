import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { handle, replyText, type Config, type Deps, type Request } from '../src/app.ts';
import { configFrom } from '../src/config.ts';
import { diSignature } from '../src/definition.ts';
import { ADD_QUESTION_CALLBACK, QUESTION_MODAL, itemKeyIn, messageLink, parseCommand, slackSignature } from '../src/slack.ts';

const SLACK = 'slack-signing-test';
const DI = 'di-channels-test';
const NOW = new Date('2026-11-22T12:00:00Z');
const TS = String(NOW.getTime() / 1000);

const cfg: Config = {
  slackSigningSecret: SLACK,
  slackBotToken: 'xoxb-test',
  definition: { url: 'https://definition.example.com', secret: DI },
  workspaces: { C0MOBILE: 'mobile' },
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake world: DI Definition answers with `definition`, Slack's API answers ok; every outgoing request is kept. */
function world(definition: { status: number; body: unknown } = { status: 200, body: { question: { id: 'hq-0123456789ab' }, duplicate: false, url: 'https://ci.example.com/#/item/PAY-123' } }) {
  const sent: Sent[] = [];
  const deferred: Promise<unknown>[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') });
    if (String(url).startsWith('https://definition.example.com/')) return new Response(JSON.stringify(definition.body), { status: definition.status });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const logs: string[] = [];
  const deps: Deps = { fetch: fakeFetch, now: () => NOW, defer: (w) => void deferred.push(w), log: (m) => void logs.push(m) };
  return { sent, deps, logs, settle: () => Promise.all(deferred) };
}

const signed = (path: string, body: string, secret = SLACK, ts = TS): Request => ({
  method: 'POST',
  path,
  headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(secret, ts, body) },
  body,
});

const commandBody = (text: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ team_id: 'T0TEAM', channel_id: 'C0MOBILE', user_id: 'U012AB3CD', user_name: 'ola', text, response_url: 'https://hooks.slack.com/commands/T0TEAM/1/abc', trigger_id: '123.456.abc', ...extra }).toString();
const interactionBody = (payload: unknown) => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

describe('Slack signature', () => {
  it('CH-01: unsigned, wrongly signed or stale requests are refused with 401', async () => {
    const w = world();
    const body = commandBody('PAY-123 Why?');
    assert.equal((await handle({ method: 'POST', path: '/slack/commands', headers: {}, body }, cfg, w.deps)).status, 401);
    assert.equal((await handle(signed('/slack/commands', body, 'other'), cfg, w.deps)).status, 401);
    assert.equal((await handle(signed('/slack/commands', body, SLACK, String(Number(TS) - 600)), cfg, w.deps)).status, 401);
    assert.equal(w.sent.length, 0);
  });

  it('CH-02: the signature matches Slack\'s documented scheme', () => {
    const expected = `v0=${createHmac('sha256', SLACK).update(`v0:${TS}:a=b`).digest('hex')}`;
    assert.equal(slackSignature(SLACK, TS, 'a=b'), expected);
  });
});

describe('/di-question', () => {
  it('CH-03: asks DI Definition (signed), then answers the person through response_url', async () => {
    const w = world();
    const res = await handle(signed('/slack/commands', commandBody('PAY-123 What if the card expires?')), cfg, w.deps);
    assert.equal(res.status, 200);
    assert.match((res.body as { text: string }).text, /Adding your question to PAY-123/);
    await w.settle();
    const [toDefinition, reply] = w.sent;
    assert.equal(toDefinition!.url, 'https://definition.example.com/api/webhooks/channels');
    assert.equal(toDefinition!.headers['x-di-signature'], diSignature(DI, toDefinition!.headers['x-di-timestamp']!, toDefinition!.body));
    assert.deepEqual(JSON.parse(toDefinition!.body), {
      id: 'slack-T0TEAM-123.456.abc',
      platform: 'slack',
      workspace: 'mobile',
      item: 'PAY-123',
      text: 'What if the card expires?',
      author: { name: 'ola', user: 'U012AB3CD' },
    });
    assert.equal(reply!.url, 'https://hooks.slack.com/commands/T0TEAM/1/abc');
    assert.match(JSON.parse(reply!.body).text, /^Added: your question is on PAY-123 — https:\/\/ci\.example\.com/);
  });

  it('CH-04: without a key and text the person gets the usage, and nothing is sent', async () => {
    const w = world();
    const res = await handle(signed('/slack/commands', commandBody('why?')), cfg, w.deps);
    assert.match((res.body as { text: string }).text, /^Usage/);
    assert.equal(w.sent.length, 0);
  });

  it('CH-05: a response_url outside hooks.slack.com is refused (no request to an arbitrary address)', async () => {
    const w = world();
    const res = await handle(signed('/slack/commands', commandBody('PAY-123 Why?', { response_url: 'https://evil.example.com/x' })), cfg, w.deps);
    assert.equal(res.status, 400);
    assert.equal(w.sent.length, 0);
  });

  it('CH-06: another Slack workspace is turned away when SLACK_TEAM_ID is set', async () => {
    const w = world();
    const res = await handle(signed('/slack/commands', commandBody('PAY-123 Why?', { team_id: 'T0OTHER' })), { ...cfg, slackTeam: 'T0TEAM' }, w.deps);
    assert.match((res.body as { text: string }).text, /not set up for this Slack workspace/);
    assert.equal(w.sent.length, 0);
  });
});

describe('message shortcut and modal', () => {
  const shortcut = {
    type: 'message_action',
    callback_id: ADD_QUESTION_CALLBACK,
    trigger_id: '999.1.x',
    team: { id: 'T0TEAM', domain: 'acme' },
    user: { id: 'U012AB3CD', name: 'ola' },
    channel: { id: 'C0MOBILE' },
    message: { text: 'For PAY-123: does this work offline?', ts: '1732276800.000100' },
  };
  const submission = (key: string, text: string, meta = { channel: 'C0MOBILE', link: 'https://acme.slack.com/archives/C0MOBILE/p1732276800000100' }) => ({
    type: 'view_submission',
    trigger_id: '999.2.y',
    team: { id: 'T0TEAM' },
    user: { id: 'U012AB3CD', name: 'ola' },
    view: { callback_id: QUESTION_MODAL, private_metadata: JSON.stringify(meta), state: { values: { item: { value: { value: key } }, text: { value: { value: text } } } } },
  });

  it('CH-07: the shortcut opens the modal prefilled with the story key and the message', async () => {
    const w = world();
    const res = await handle(signed('/slack/interactions', interactionBody(shortcut)), cfg, w.deps);
    assert.equal(res.status, 200);
    const open = w.sent[0]!;
    assert.equal(open.url, 'https://slack.com/api/views.open');
    assert.equal(open.headers.authorization, 'Bearer xoxb-test');
    const view = JSON.parse(open.body).view;
    assert.equal(view.blocks[0].element.initial_value, 'PAY-123');
    assert.equal(view.blocks[1].element.initial_value, 'For PAY-123: does this work offline?');
    assert.deepEqual(JSON.parse(view.private_metadata), { channel: 'C0MOBILE', link: 'https://acme.slack.com/archives/C0MOBILE/p1732276800000100' });
  });

  it('CH-08: sending the modal records the question with the message link and shows the result', async () => {
    const w = world();
    const res = await handle(signed('/slack/interactions', interactionBody(submission('pay-123', 'Does this work offline?'))), cfg, w.deps);
    const sent = JSON.parse(w.sent[0]!.body);
    assert.equal(sent.item, 'PAY-123');
    assert.equal(sent.link, 'https://acme.slack.com/archives/C0MOBILE/p1732276800000100');
    assert.equal(sent.workspace, 'mobile');
    const body = res.body as { response_action: string; view: { blocks: { text: { text: string } }[] } };
    assert.equal(body.response_action, 'update');
    assert.match(body.view.blocks[0]!.text.text, /^Added/);
  });

  it('CH-09: an unknown story or a bad key is shown on the key field, the modal stays open', async () => {
    const w = world({ status: 404, body: { detail: 'No work item NOPE-1' } });
    const unknown = await handle(signed('/slack/interactions', interactionBody(submission('NOPE-1', 'Why?'))), cfg, w.deps);
    assert.deepEqual(unknown.body, { response_action: 'errors', errors: { item: 'There is no story NOPE-1 in DI Definition' } });
    const bad = await handle(signed('/slack/interactions', interactionBody(submission('pay 1', 'Why?'))), cfg, w.deps);
    assert.equal((bad.body as { response_action: string }).response_action, 'errors');
  });

  it('CH-10: DI Definition down: the person is told it is safe to send again', async () => {
    const w = world({ status: 503, body: {} });
    const res = await handle(signed('/slack/interactions', interactionBody(submission('PAY-123', 'Why?'))), cfg, w.deps);
    assert.match(JSON.stringify(res.body), /did not answer/);
  });
});

describe('helpers and configuration', () => {
  it('CH-11: key, link and command parsing', () => {
    assert.equal(itemKeyIn('see PAY-123 and CHK-9'), 'PAY-123');
    assert.equal(itemKeyIn('no key here'), undefined);
    assert.equal(messageLink('acme', 'C0MOBILE', '1732276800.000100'), 'https://acme.slack.com/archives/C0MOBILE/p1732276800000100');
    assert.equal(messageLink('evil.com/x', 'C0MOBILE', '1.2'), undefined);
    assert.deepEqual(parseCommand('PAY-7   multi\nline'), { key: 'PAY-7', text: 'multi\nline' });
    assert.match(replyText({ ok: false, reason: 'unknown_item' }, 'X-1'), /no story X-1/);
  });

  it('CH-12: configuration names a missing setting and refuses plain http to a remote host', () => {
    const env = { SLACK_SIGNING_SECRET: 's', SLACK_BOT_TOKEN: 'xoxb-1', CI_CHANNELS_SIGNING_SECRET: 'c', DI_DEFINITION_URL: 'https://ci.example.com', DI_CHANNELS_WORKSPACES: 'C0MOBILE=mobile' };
    assert.deepEqual(configFrom(env).workspaces, { C0MOBILE: 'mobile' });
    assert.throws(() => configFrom({ ...env, SLACK_BOT_TOKEN: '' }), /SLACK_BOT_TOKEN is not set/);
    assert.throws(() => configFrom({ ...env, DI_DEFINITION_URL: 'http://ci.example.com' }), /https/);
    assert.throws(() => configFrom({ ...env, DI_CHANNELS_WORKSPACES: 'oops' }), /CHANNEL_ID=workspace/);
    assert.doesNotThrow(() => configFrom({ ...env, DI_DEFINITION_URL: 'http://localhost:8787' }));
  });
});
