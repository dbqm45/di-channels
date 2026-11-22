import { askDefinition, type AskResult, type ChannelQuestion, type DefinitionLink } from './definition.ts';
import { ADD_QUESTION_CALLBACK, QUESTION_MODAL, itemKeyIn, messageLink, parseCommand, questionModal, slackSignatureProblem, type ModalState } from './slack.ts';

export interface Config {
  slackSigningSecret: string;
  slackBotToken: string;
  /** Only this Slack workspace (team id) may use the app; unset: any workspace the app is installed in. */
  slackTeam?: string;
  definition: DefinitionLink;
  /** Slack channel id → DI Definition workspace id; a channel not listed goes to the default workspace. */
  workspaces: Record<string, string>;
  /** How long the modal waits for DI Definition before answering Slack (Slack allows 3 s in all). */
  modalTimeoutMs?: number;
}

export interface Request {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface Response {
  status: number;
  body?: unknown;
}

export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
  /** Work after the answer to Slack (the slash command replies through its response_url). */
  defer: (work: Promise<unknown>) => void;
  log: (msg: string) => void;
}

const ok = (body?: unknown): Response => ({ status: 200, ...(body !== undefined && { body }) });
const RESPONSE_URL = /^https:\/\/hooks\.slack\.com\/[A-Za-z0-9/_-]+$/;
const eventId = (team: string, trigger: string) => `slack-${team}-${trigger}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);

/** One line for the person in Slack; never the content of the question. */
export function replyText(r: AskResult, key: string): string {
  if (r.ok) return `${r.duplicate ? 'Already added' : 'Added'}: your question is on ${key}${r.url ? ` — ${r.url}` : ''}. It counts for readiness once the Product Owner accepts it.`;
  if (r.reason === 'unknown_item') return `There is no story ${key} in DI Definition. Check the key and try again.`;
  if (r.reason === 'rejected') return `DI Definition did not accept the question${r.detail ? `: ${r.detail}` : ''}.`;
  return 'DI Definition did not answer. Try again in a moment — sending the same question twice does not add it twice.';
}

export async function handle(req: Request, cfg: Config, deps: Deps): Promise<Response> {
  if (req.method === 'GET' && req.path === '/health') return ok({ ok: true });
  if (req.method !== 'POST' || (req.path !== '/slack/commands' && req.path !== '/slack/interactions')) return { status: 404 };
  const problem = slackSignatureProblem(cfg.slackSigningSecret, req.headers['x-slack-request-timestamp'], req.body, req.headers['x-slack-signature'], deps.now());
  if (problem) {
    deps.log(`refused a Slack request: ${problem}`);
    return { status: 401 };
  }
  const form = new URLSearchParams(req.body);
  return req.path === '/slack/commands' ? command(form, cfg, deps) : interaction(form, cfg, deps);
}

const otherTeam = (cfg: Config, team: string | undefined) => !!cfg.slackTeam && team !== cfg.slackTeam;

async function command(form: URLSearchParams, cfg: Config, deps: Deps): Promise<Response> {
  const team = form.get('team_id') ?? '';
  if (otherTeam(cfg, team)) return ok({ response_type: 'ephemeral', text: 'This app is not set up for this Slack workspace.' });
  const parsed = parseCommand(form.get('text') ?? '');
  if ('help' in parsed) return ok({ response_type: 'ephemeral', text: parsed.help });
  const responseUrl = form.get('response_url') ?? '';
  if (!RESPONSE_URL.test(responseUrl)) return { status: 400 };
  const channel = form.get('channel_id') ?? '';
  const user = form.get('user_id') ?? '';
  const q: ChannelQuestion = {
    id: eventId(team, form.get('trigger_id') ?? `${channel}-${deps.now().getTime()}`),
    platform: 'slack',
    ...(cfg.workspaces[channel] && { workspace: cfg.workspaces[channel] }),
    item: parsed.key,
    text: parsed.text,
    author: { name: (form.get('user_name') || user).slice(0, 80), user },
  };
  deps.defer(
    askDefinition({ ...cfg.definition, fetch: deps.fetch }, q).then((r) =>
      deps.fetch(responseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', text: replyText(r, q.item) }) }),
    ),
  );
  return ok({ response_type: 'ephemeral', text: `Adding your question to ${parsed.key}…` });
}

interface Interaction {
  type?: string;
  callback_id?: string;
  trigger_id?: string;
  response_url?: string;
  team?: { id?: string; domain?: string };
  user?: { id?: string; name?: string; username?: string };
  channel?: { id?: string };
  message?: { text?: string; ts?: string };
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string | null }>> } };
}

async function interaction(form: URLSearchParams, cfg: Config, deps: Deps): Promise<Response> {
  let p: Interaction;
  try {
    p = JSON.parse(form.get('payload') ?? '');
  } catch {
    return { status: 400 };
  }
  if (otherTeam(cfg, p.team?.id)) return ok();

  // Message shortcut "Add question to a story": open the modal, prefilled from the message.
  if (p.type === 'message_action' && p.callback_id === ADD_QUESTION_CALLBACK) {
    const text = p.message?.text ?? '';
    const state: ModalState = { channel: p.channel?.id ?? '', ...(messageLink(p.team?.domain, p.channel?.id, p.message?.ts) && { link: messageLink(p.team?.domain, p.channel?.id, p.message?.ts) }) };
    const res = await deps.fetch('https://slack.com/api/views.open', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${cfg.slackBotToken}` },
      body: JSON.stringify({ trigger_id: p.trigger_id, view: questionModal(state, itemKeyIn(text), text) }),
    }).catch(() => undefined);
    const answer = (await res?.json().catch(() => undefined)) as { ok?: boolean; error?: string } | undefined;
    if (!answer?.ok) deps.log(`views.open failed: ${answer?.error ?? 'no answer'}`);
    return ok();
  }

  // The modal sent: ask DI Definition within Slack's time limit and show the result in the modal.
  if (p.type === 'view_submission' && p.view?.callback_id === QUESTION_MODAL) {
    const values = p.view.state?.values ?? {};
    const key = (values.item?.value?.value ?? '').trim().toUpperCase();
    const text = (values.text?.value?.value ?? '').trim();
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return ok({ response_action: 'errors', errors: { item: 'A story key such as PAY-123' } });
    if (!text) return ok({ response_action: 'errors', errors: { text: 'Write the question' } });
    let state: ModalState = { channel: '' };
    try {
      state = JSON.parse(p.view.private_metadata ?? '{}');
    } catch {
      /* no channel: default workspace */
    }
    const user = p.user?.id ?? '';
    const q: ChannelQuestion = {
      id: eventId(p.team?.id ?? '', p.trigger_id ?? `${user}-${deps.now().getTime()}`),
      platform: 'slack',
      ...(cfg.workspaces[state.channel] && { workspace: cfg.workspaces[state.channel] }),
      item: key,
      text,
      ...(state.link && { link: state.link }),
      author: { name: (p.user?.name || p.user?.username || user).slice(0, 80), user },
    };
    const r = await askDefinition({ ...cfg.definition, fetch: deps.fetch, timeoutMs: cfg.modalTimeoutMs ?? 2500 }, q);
    if (!r.ok && r.reason === 'unknown_item') return ok({ response_action: 'errors', errors: { item: `There is no story ${key} in DI Definition` } });
    return ok({
      response_action: 'update',
      view: { type: 'modal', title: { type: 'plain_text', text: 'Question for a story' }, close: { type: 'plain_text', text: 'Close' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: replyText(r, key) } }] },
    });
  }
  return ok();
}
