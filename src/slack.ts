import { createHmac, timingSafeEqual } from 'node:crypto';

/** Slack signs every request: `v0=<hex HMAC-SHA256(signing secret, "v0:<timestamp>:<raw body>")>`, 5-minute window. */
export const SLACK_TOLERANCE_SECONDS = 300;

export function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

/** Null when the request comes from Slack, else why not (never echoing what was sent). */
export function slackSignatureProblem(secret: string, timestamp: string | undefined, body: string, signature: string | undefined, now: Date): string | null {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return 'missing or invalid X-Slack-Request-Timestamp';
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SLACK_TOLERANCE_SECONDS) return 'the request timestamp is too old or in the future';
  const expected = slackSignature(secret, timestamp, body);
  if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return 'invalid X-Slack-Signature';
  return null;
}

/** The first work item key in a text (PAY-123), the shape DI Definition accepts. */
export function itemKeyIn(text: string): string | undefined {
  return /\b([A-Z][A-Z0-9_]*-\d+)\b/.exec(text)?.[1];
}

/** A link to a message, built from the payload alone (no API call, no extra scope). */
export function messageLink(domain: string | undefined, channel: string | undefined, ts: string | undefined): string | undefined {
  if (!domain || !/^[a-z0-9-]{1,63}$/.test(domain) || !channel || !/^[A-Z0-9]{2,20}$/.test(channel) || !ts || !/^\d+\.\d+$/.test(ts)) return undefined;
  return `https://${domain}.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
}

export const ADD_QUESTION_CALLBACK = 'di_add_question';
export const QUESTION_MODAL = 'di_question_modal';

export interface ModalState {
  channel: string;
  responseUrl?: string;
  link?: string;
}

/** The modal behind the message shortcut: the story key and the question, both editable before sending. */
export function questionModal(state: ModalState, key: string | undefined, text: string) {
  return {
    type: 'modal',
    callback_id: QUESTION_MODAL,
    private_metadata: JSON.stringify(state),
    title: { type: 'plain_text', text: 'Question for a story' },
    submit: { type: 'plain_text', text: 'Add question' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'item',
        label: { type: 'plain_text', text: 'Story key' },
        element: { type: 'plain_text_input', action_id: 'value', placeholder: { type: 'plain_text', text: 'PAY-123' }, ...(key && { initial_value: key }) },
      },
      {
        type: 'input',
        block_id: 'text',
        label: { type: 'plain_text', text: 'Question or thought' },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 2000, ...(text && { initial_value: text.slice(0, 2000) }) },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'The whole team sees it with your name. It counts for readiness once the Product Owner accepts it.' }] },
    ],
  };
}

const USAGE = 'Usage: `/di-question PAY-123 What happens if the card expires?`';

/** What `/di-question PAY-123 text` asks for, or the help text. */
export function parseCommand(text: string): { key: string; text: string } | { help: string } {
  const m = /^\s*([A-Z][A-Z0-9_]*-\d+)\s+([\s\S]+)$/.exec(text);
  if (!m || !m[2]!.trim()) return { help: USAGE };
  return { key: m[1]!, text: m[2]!.trim() };
}
