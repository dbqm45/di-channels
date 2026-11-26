/**
 * DI Team T6 (dbqm45/pdi docs/plan-t6-skroty-slack.md): two messages from DI Decision, signed like "waiting for you"
 * (`X-PDI-Signature`), both for people pdi knows only by their suite `sub`:
 * - `POST /pdi/asked` ("Ask team"): every asked person gets a direct message — who asks, about what, until when, and a
 *   link to answer in DI Decision. pdi gets back who was reached, so the decider can see who was not.
 * - `POST /pdi/digest`: once a working day, one message per person: what waits for their decision, what they were
 *   asked, what is with the team and how much is on the agenda. pdi decides the content; this only words it.
 * Not contract events: an API between pdi and this service, like `gate.waiting`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 10;
const MAX_PEOPLE = 20;

export interface Asked {
  id: string;
  item: string;
  summary: string;
  askedBy: string;
  people: string[];
  options: string[];
  closesAt: string;
  change?: string;
  gate?: string;
  url?: string;
}

export interface DigestWaiting {
  item: string;
  summary: string;
  stage: string;
  due: string;
  change?: string;
  gate?: string;
  url?: string;
}

export interface Digest {
  id: string;
  to: { approver: true } | { person: string };
  day: string;
  waiting: { total: number; items: DigestWaiting[] };
  withTeam: { item: string; summary: string; answered: number; asked: number; closesAt: string }[];
  askedOfYou: { item: string; summary: string; askedBy: string; closesAt: string; url?: string }[];
  toDiscuss: { count: number; url?: string };
  unreachable: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (o: Obj, k: string, max: number) => typeof o[k] === 'string' && (o[k] as string).trim().length > 0 && (o[k] as string).length <= max;
const count = (v: unknown, max = 10_000) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
/** A link into DI Decision: http(s), never with the console's link token. */
const goodUrl = (v: unknown) => v === undefined || (typeof v === 'string' && v.length <= 500 && /^https?:\/\/\S+$/.test(v) && !/[?&]t=/.test(v));
const opt = (o: Obj, k: string, max: number) => o[k] === undefined || text(o, k, max);

export function parseAsked(body: unknown): Asked | string {
  if (!isObj(body)) return 'the body must be a JSON object';
  if (body.type !== 'team.asked') return 'type must be team.asked';
  for (const [k, max] of [['id', 128], ['item', 128], ['summary', 300], ['asked_by', 80]] as const) if (!text(body, k, max)) return `${k}: missing or too long`;
  const people = body.people;
  if (!Array.isArray(people) || people.length === 0 || people.length > MAX_PEOPLE || !people.every((p) => typeof p === 'string' && UUID.test(p))) return `people: 1–${MAX_PEOPLE} suite person ids`;
  const options = body.options;
  if (!Array.isArray(options) || options.length === 0 || options.length > 10 || !options.every((o) => typeof o === 'string' && o.length > 0 && o.length <= 40)) return 'options: 1–10 short names';
  if (typeof body.closes_at !== 'string' || !ISO.test(body.closes_at)) return 'closes_at: a UTC time like 2026-11-23T13:00:00Z';
  if (!opt(body, 'change', 40) || !opt(body, 'gate', 120)) return 'change or gate: too long';
  if (!goodUrl(body.url)) return 'url: an http(s) address without a session token';
  return {
    id: body.id as string,
    item: body.item as string,
    summary: body.summary as string,
    askedBy: body.asked_by as string,
    people: [...new Set(people as string[])],
    options: options as string[],
    closesAt: body.closes_at,
    ...(body.change !== undefined && { change: body.change as string }),
    ...(body.gate !== undefined && { gate: body.gate as string }),
    ...(body.url !== undefined && { url: body.url as string }),
  };
}

export function parseDigest(body: unknown): Digest | string {
  if (!isObj(body)) return 'the body must be a JSON object';
  if (body.type !== 'team.digest') return 'type must be team.digest';
  if (!text(body, 'id', 128)) return 'id: missing or too long';
  const to = body.to;
  let recipient: Digest['to'];
  if (isObj(to) && to.approver === true && to.person === undefined) recipient = { approver: true };
  else if (isObj(to) && typeof to.person === 'string' && UUID.test(to.person) && to.approver === undefined) recipient = { person: to.person };
  else return 'to: { approver: true } or { person: <suite person id> }';
  if (typeof body.day !== 'string' || !DAY.test(body.day)) return 'day: a date YYYY-MM-DD';

  const w = body.waiting;
  if (!isObj(w) || !count(w.total) || !Array.isArray(w.items) || w.items.length > MAX_ITEMS) return `waiting: { total, items: at most ${MAX_ITEMS} }`;
  const waiting: DigestWaiting[] = [];
  for (const i of w.items) {
    if (!isObj(i) || !text(i, 'item', 128) || !text(i, 'summary', 300) || !text(i, 'stage', 20) || typeof i.due !== 'string' || !DAY.test(i.due)) return 'waiting.items: item, summary, stage and due';
    if (!opt(i, 'change', 40) || !opt(i, 'gate', 120) || !goodUrl(i.url)) return 'waiting.items: change, gate or url';
    waiting.push({
      item: i.item as string,
      summary: i.summary as string,
      stage: i.stage as string,
      due: i.due,
      ...(i.change !== undefined && { change: i.change as string }),
      ...(i.gate !== undefined && { gate: i.gate as string }),
      ...(i.url !== undefined && { url: i.url as string }),
    });
  }

  const listOf = (k: string): Obj[] | string => {
    const v = body[k];
    if (!Array.isArray(v) || v.length > MAX_ITEMS || !v.every(isObj)) return `${k}: at most ${MAX_ITEMS} entries`;
    return v as Obj[];
  };
  const team = listOf('with_team');
  if (typeof team === 'string') return team;
  if (!team.every((t) => text(t, 'item', 128) && text(t, 'summary', 300) && count(t.answered, MAX_PEOPLE) && count(t.asked, MAX_PEOPLE) && typeof t.closes_at === 'string' && ISO.test(t.closes_at))) return 'with_team: item, summary, answered, asked, closes_at';
  const mine = listOf('asked_of_you');
  if (typeof mine === 'string') return mine;
  if (!mine.every((a) => text(a, 'item', 128) && text(a, 'summary', 300) && text(a, 'asked_by', 80) && typeof a.closes_at === 'string' && ISO.test(a.closes_at) && goodUrl(a.url))) return 'asked_of_you: item, summary, asked_by, closes_at, url';
  const discuss = body.to_discuss;
  if (!isObj(discuss) || !count(discuss.count) || !goodUrl(discuss.url)) return 'to_discuss: { count, url? }';
  const unreachable = body.unreachable ?? [];
  if (!Array.isArray(unreachable) || unreachable.length > MAX_PEOPLE || !unreachable.every((n) => typeof n === 'string' && n.length > 0 && n.length <= 80)) return 'unreachable: names';

  return {
    id: body.id as string,
    to: recipient,
    day: body.day,
    waiting: { total: Math.max(w.total as number, waiting.length), items: waiting },
    withTeam: team.map((t) => ({ item: t.item as string, summary: t.summary as string, answered: t.answered as number, asked: t.asked as number, closesAt: t.closes_at as string })),
    askedOfYou: mine.map((a) => ({ item: a.item as string, summary: a.summary as string, askedBy: a.asked_by as string, closesAt: a.closes_at as string, ...(a.url !== undefined && { url: a.url as string }) })),
    toDiscuss: { count: discuss.count as number, ...(discuss.url !== undefined && { url: discuss.url as string }) },
    unreachable: unreachable as string[],
  };
}

/** Nothing to say: no message at all (a digest that says "nothing" is noise). */
export const digestEmpty = (d: Digest) => d.waiting.total === 0 && d.withTeam.length === 0 && d.askedOfYou.length === 0 && d.toDiscuss.count === 0;

/** Slack mrkdwn: escape the three characters Slack treats as control characters. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (url: string | undefined, label: string) => (url ? ` <${url}|${label}>` : '');
const where = (change?: string, gate?: string) => [change, gate && !gate.startsWith('stage:') ? gate : gate?.split(':').slice(1).join(' → ')].filter(Boolean).join(' · ');

/** "14:00 on 2026-11-23" in the team's time zone. */
export function localWhen(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.hour}:${parts.minute} on ${parts.year}-${parts.month}-${parts.day}`;
}

export function askedText(a: Asked, timeZone: string): string {
  const what = where(a.change, a.gate);
  const options = `${a.options.join(', ')} or talk live`;
  const answer = a.url ? `<${a.url}|Answer in DI Decision>` : 'Answer in DI Decision (Inbox).';
  return (
    `*${esc(a.askedBy)} asks for your view*${what ? ` — ${esc(what)}` : ''}\n${esc(a.summary)}\n` +
    `Pick one of ${esc(options)} and say why in one sentence. Answers stay hidden until it closes ${localWhen(a.closesAt, timeZone)}. ${answer}`
  );
}

const STAGE: Record<string, string> = { reminder: 'Reminder', due_today: 'Due today', overdue: 'Overdue', paused: 'Paused', review: 'On the review list' };

export function digestText(d: Digest, timeZone: string): string {
  const lines = [`*Your day in DI Decision — ${d.day}*`];
  if (d.waiting.total > 0) {
    lines.push('', `*Waiting for your decision (${d.waiting.total})*`);
    for (const w of d.waiting.items) {
      const head = [STAGE[w.stage], where(w.change, w.gate)].filter(Boolean).join(' — ');
      const due = ['new', 'reminder'].includes(w.stage) ? `due ${w.due}` : w.stage === 'due_today' ? 'due today' : `was due ${w.due}`;
      lines.push(`• ${head ? `${esc(head)}: ` : ''}${esc(w.summary)} (${due})${link(w.url, 'Decide')}`);
    }
    const more = d.waiting.total - d.waiting.items.length;
    if (more > 0) lines.push(`…and ${more} more`);
  }
  if (d.askedOfYou.length > 0) {
    lines.push('', `*Asked of you (${d.askedOfYou.length})*`);
    for (const a of d.askedOfYou) lines.push(`• ${esc(a.askedBy)} asks: ${esc(a.summary)} — closes ${localWhen(a.closesAt, timeZone)}${link(a.url, 'Answer')}`);
  }
  if (d.withTeam.length > 0) {
    lines.push('', `*With the team (${d.withTeam.length})*`);
    for (const t of d.withTeam) lines.push(`• ${esc(t.summary)}: ${t.answered} of ${t.asked} answered, closes ${localWhen(t.closesAt, timeZone)}`);
  }
  if (d.toDiscuss.count > 0) lines.push('', `*To discuss: ${d.toDiscuss.count}*${link(d.toDiscuss.url, 'Open the agenda')}`);
  if (d.unreachable.length > 0) lines.push('', `Not reachable in Slack: ${esc(d.unreachable.join(', '))}`);
  return lines.join('\n');
}
