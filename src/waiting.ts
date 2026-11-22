import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * "Waiting for you" from DI Decision (pdi, step 17 / CH2): `POST /pdi/waiting`, signed like pdi's other messages
 * (`X-PDI-Signature: v1=<hex HMAC-SHA256(PDI_CHANNELS_SIGNING_SECRET, "<X-PDI-Timestamp>.<raw body>")>`, 5 minutes).
 * The approver gets a direct message; inside quiet hours (operating model OM1: 18:00–8:00 and weekends) Slack holds
 * it until 8:00 of the next working day (chat.scheduleMessage), so nothing is queued here.
 */
export interface WaitingConfig {
  secret: string;
  /** Slack user id of the approver (OM1: one approver, no deputy). */
  approver: string;
  /** IANA time zone of the quiet hours; Europe/Warsaw by default. */
  timeZone: string;
}

export const STAGES = ['new', 'reminder', 'due_today', 'overdue', 'paused', 'review'] as const;
export type Stage = (typeof STAGES)[number];

export interface Waiting {
  id: string;
  /** N3: which step of the deadline this is; absent in messages from before N3 means new. */
  stage: Stage;
  item: string;
  kind: string;
  summary: string;
  due: string;
  business_days: number;
  where: string;
  change?: string;
  gate?: string;
  url?: string;
}

export const PDI_TOLERANCE_SECONDS = 300;
export const QUIET_FROM = 18;
export const QUIET_UNTIL = 8;

export const pdiSignature = (secret: string, timestamp: string, body: string) => `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

export function pdiSignatureProblem(secret: string, timestamp: string | undefined, body: string, signature: string | undefined, now: Date): string | null {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return 'missing or invalid X-PDI-Timestamp';
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > PDI_TOLERANCE_SECONDS) return 'the pdi timestamp is too old or in the future';
  const expected = pdiSignature(secret, timestamp, body);
  if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return 'invalid X-PDI-Signature';
  return null;
}

/** The message pdi sends, or why it is not one. Only the fields used are kept. */
export function parseWaiting(body: unknown): Waiting | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object';
  const b = body as Record<string, unknown>;
  const str = (k: string, max: number) => typeof b[k] === 'string' && (b[k] as string).length > 0 && (b[k] as string).length <= max;
  if (b.type !== 'gate.waiting') return 'type must be gate.waiting';
  if (b.stage !== undefined && !STAGES.includes(b.stage as Stage)) return `stage: one of ${STAGES.join(', ')}`;
  for (const [k, max] of [['id', 128], ['item', 128], ['kind', 40], ['summary', 300], ['where', 100]] as const) if (!str(k, max)) return `${k}: missing or too long`;
  if (!str('due', 10) || !/^\d{4}-\d{2}-\d{2}$/.test(b.due as string)) return 'due: a date YYYY-MM-DD';
  if (typeof b.business_days !== 'number' || !Number.isInteger(b.business_days) || b.business_days < 0 || b.business_days > 60) return 'business_days: a whole number';
  if (b.change !== undefined && !str('change', 40)) return 'change: too long';
  if (b.gate !== undefined && !str('gate', 120)) return 'gate: too long';
  if (b.url !== undefined && (!str('url', 500) || !/^https?:\/\/\S+$/.test(b.url as string) || /[?&]t=/.test(b.url as string))) return 'url: an http(s) address without a session token';
  return {
    id: b.id as string,
    stage: (b.stage as Stage | undefined) ?? 'new',
    item: b.item as string,
    kind: b.kind as string,
    summary: b.summary as string,
    due: b.due as string,
    business_days: b.business_days,
    where: b.where as string,
    ...(b.change !== undefined && { change: b.change as string }),
    ...(b.gate !== undefined && { gate: b.gate as string }),
    ...(b.url !== undefined && { url: b.url as string }),
  };
}

/** Slack mrkdwn: escape the three characters Slack treats as control characters. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The first line per stage (operating model OM1 §4–§5). */
const HEADS: Record<Stage, string> = {
  new: 'Waiting for your decision',
  reminder: 'Reminder: waiting for your decision',
  due_today: 'Due today: waiting for your decision',
  overdue: 'Overdue: waiting for your decision',
  paused: 'Overdue twice the deadline: the change is paused',
  review: 'Overdue four times the deadline: on the review list',
};

/** What the deadline did, where it did something. */
const EFFECTS: Partial<Record<Stage, string>> = {
  paused: 'No next phase starts until you decide.',
  review: 'Decide, reject or put the change aside with a return condition.',
};

/** One message the approver can act on: what, for which change, by when, where to decide. */
export function waitingText(w: Waiting): string {
  const what = [w.change, w.gate && !w.gate.startsWith('stage:') ? w.gate : w.gate?.split(':').slice(1).join(' → ')].filter(Boolean).join(' · ');
  const where = w.url ? `<${w.url}|Decide in DI Decision>` : `Decide in DI Decision: \`${esc(w.where)}\``;
  const days = `${w.business_days} working ${w.business_days === 1 ? 'day' : 'days'}`;
  const head = HEADS[w.stage];
  const when =
    w.stage === 'new' || w.stage === 'reminder' ? `Due ${w.due} (${days}).` : w.stage === 'due_today' ? `Due today, ${w.due}.` : `Was due ${w.due}.`;
  const effect = EFFECTS[w.stage];
  return `*${head}*${what ? ` — ${esc(what)}` : ''}\n${esc(w.summary)}\n${when}${effect ? ` ${effect}` : ''} ${where}`;
}

interface LocalTime {
  weekday: number; // 1 = Monday … 7 = Sunday
  hour: number;
  minute: number;
  year: number;
  month: number;
  day: number;
}

function localTime(at: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday!) + 1,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(at: Date, timeZone: string): number {
  const l = localTime(at, timeZone);
  return Math.round((Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute) - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/** Null inside working hours (send now); else the instant of 8:00 local time on the next working day. */
export function deliverAt(now: Date, timeZone: string): Date | null {
  const l = localTime(now, timeZone);
  const working = l.weekday <= 5 && l.hour >= QUIET_UNTIL && l.hour < QUIET_FROM;
  if (working) return null;
  // The first day from today (before 8:00) or tomorrow on that is Monday–Friday.
  let days = l.weekday <= 5 && l.hour < QUIET_UNTIL ? 0 : 1;
  while (((l.weekday - 1 + days) % 7) + 1 > 5) days++;
  const noonUtc = new Date(Date.UTC(l.year, l.month - 1, l.day + days, 12));
  const target = Date.UTC(l.year, l.month - 1, l.day + days, QUIET_UNTIL) - offsetMinutes(noonUtc, timeZone) * 60000;
  return new Date(target);
}
