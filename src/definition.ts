import { createHmac } from 'node:crypto';

/**
 * DI Definition (ci_for_sdlc): `POST /api/webhooks/channels`, signed with the secret shared with it
 * (`X-DI-Signature: v1=<hex HMAC-SHA256(secret, "<X-DI-Timestamp>.<raw body>")>`). The body is described in
 * ci_for_sdlc docs/CHANNELS.md.
 */
export interface DefinitionLink {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  clock?: () => Date;
  timeoutMs?: number;
}

export interface ChannelQuestion {
  id: string;
  platform: 'slack';
  workspace?: string;
  item: string;
  text: string;
  link?: string;
  /** `suite_id`: the suite person matched to the Slack user (by e-mail, through di-identity); then `name` is the suite name. */
  author: { name: string; user: string; suite_id?: string };
}

export type AskResult =
  | { ok: true; duplicate: boolean; url?: string; questionId: string }
  | { ok: false; reason: 'unknown_item' | 'rejected' | 'unavailable'; detail?: string };

export const diSignature = (secret: string, timestamp: string, body: string) => `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

export async function askDefinition(link: DefinitionLink, q: ChannelQuestion): Promise<AskResult> {
  const body = JSON.stringify(q);
  const ts = String(Math.floor((link.clock ?? (() => new Date()))().getTime() / 1000));
  let res: Response;
  try {
    res = await (link.fetch ?? fetch)(`${link.url.replace(/\/+$/, '')}/api/webhooks/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-di-timestamp': ts, 'x-di-signature': diSignature(link.secret, ts, body) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(link.timeoutMs ?? 10_000),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const json = (await res.json().catch(() => ({}))) as { detail?: string; duplicate?: boolean; url?: string; question?: { id?: string } };
  if (res.ok && json.question?.id) return { ok: true, duplicate: !!json.duplicate, questionId: json.question.id, ...(json.url && { url: json.url }) };
  if (res.status === 404 && json.detail?.startsWith('No work item')) return { ok: false, reason: 'unknown_item' };
  if (res.status === 400) return { ok: false, reason: 'rejected', ...(json.detail && { detail: json.detail.slice(0, 200) }) };
  return { ok: false, reason: 'unavailable' };
}
