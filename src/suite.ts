/**
 * The suite person behind a Slack user (ADR 17 in dbqm45/pdi): the user's e-mail from Slack (`users.info`, scope
 * `users:read.email`), then `GET <di-identity>/api/people?email=` with this service's own token (client credentials of
 * the `di-channels` client in the suite realm, role `di-identity:people-reader`). The answer is `sub` and the suite
 * name; DI Definition then shows the suite person as the author of the question.
 *
 * Never blocks a question: any failure or no match gives null, and the question goes with the Slack name as before.
 * Each null says why in the log (no e-mail from Slack, no such person in the suite, or the error), once per cache
 * period, so a missing suite author is one log line to explain.
 * Results are kept per Slack user for an hour (no match for 10 minutes), so a modal stays within Slack's 3 seconds.
 * The e-mail is never logged and never sent anywhere but to di-identity.
 */
export interface SuiteLink {
  /** Issuer of the suite realm, e.g. https://id.example.com/realms/suite. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** di-identity, e.g. https://id.example.com (its API is under /api). */
  identityUrl: string;
}

export interface SuitePerson {
  sub: string;
  name: string;
}

export type FindSuitePerson = (slackUser: string) => Promise<SuitePerson | null>;

const FOUND_TTL_MS = 60 * 60 * 1000;
const MISSING_TTL_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why a Slack user has no suite person (an answer, not a failure); logged, never with the e-mail. */
class Miss extends Error {}

export function suitePeople(link: SuiteLink, deps: { fetch: typeof fetch; now: () => Date; log: (m: string) => void; slackBotToken: string }): FindSuitePerson {
  const cache = new Map<string, { person: SuitePerson | null; until: number }>();
  const now = () => deps.now().getTime();
  const call = (url: string, init: RequestInit) => deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });

  const serviceToken = tokenSource(link, call, now);

  const slackEmail = async (user: string): Promise<string> => {
    const res = await call('https://slack.com/api/users.info', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${deps.slackBotToken}` },
      body: new URLSearchParams({ user }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; user?: { deleted?: boolean; is_bot?: boolean; profile?: { email?: string } } };
    if (!body.ok) throw new Error(`users.info: ${body.error ?? `HTTP ${res.status}`}`);
    if (body.user?.deleted || body.user?.is_bot) throw new Miss('a deleted user or a bot in Slack');
    const email = body.user?.profile?.email?.trim().toLowerCase();
    if (!email) throw new Miss('Slack gave no e-mail (scope users:read.email, then reinstall the app)');
    return email;
  };

  const lookup = async (user: string): Promise<SuitePerson> => {
    const email = await slackEmail(user);
    const res = await call(`${link.identityUrl}/api/people?email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${await serviceToken()}` } });
    if (res.status === 404) {
      // di-identity's own 404 carries a JSON error; an empty one is another service at DI_IDENTITY_URL.
      const answer = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (typeof answer?.error !== 'string') throw new Error('DI_IDENTITY_URL answered 404 without a di-identity answer: is it the di-identity address?');
      throw new Miss('no single suite person with the Slack e-mail (di-identity answered 404)');
    }
    if (!res.ok) throw new Error(`di-identity answered HTTP ${res.status}`);
    const body = (await res.json()) as { sub?: unknown; name?: unknown };
    if (typeof body.sub !== 'string' || !UUID.test(body.sub) || typeof body.name !== 'string' || !body.name.trim()) throw new Error('di-identity gave no person');
    return { sub: body.sub, name: body.name.trim().slice(0, 80) };
  };

  return async (user: string) => {
    const hit = cache.get(user);
    if (hit && now() < hit.until) return hit.person;
    try {
      const person = await lookup(user);
      cache.set(user, { person, until: now() + FOUND_TTL_MS });
      return person;
    } catch (err) {
      if (err instanceof Miss) cache.set(user, { person: null, until: now() + MISSING_TTL_MS });
      deps.log(`suite person for a Slack user not found: ${(err as Error).message}`);
      return null;
    }
  };
}

/** The finder, but giving up (null) after `ms`; for the modal, which must answer Slack within 3 seconds. */
export const within = (find: FindSuitePerson, ms: number): FindSuitePerson => (user) =>
  Promise.race([find(user), new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);

/** This app's own service token (client credentials), kept until 30 s before it expires. */
function tokenSource(link: SuiteLink, call: (url: string, init: RequestInit) => Promise<Response>, now: () => number): () => Promise<string> {
  let token = '';
  let tokenUntil = 0;
  return async () => {
    if (token && now() < tokenUntil) return token;
    const res = await call(`${link.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: link.clientId, client_secret: link.clientSecret }).toString(),
    });
    if (!res.ok) throw new Error(`the suite token request answered HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('the suite gave no token');
    token = body.access_token;
    tokenUntil = now() + Math.max(10, (body.expires_in ?? 60) - 30) * 1000;
    return token;
  };
}

/** The Slack user of a suite person (`sub`), or null; for messages pdi sends to a person it knows only by `sub`. */
export type FindSlackUser = (sub: string) => Promise<string | null>;

/**
 * The other way round (DI Team T6): suite `sub` → `GET <di-identity>/api/people/<sub>` (the verified e-mail, only for
 * this app, DI3) → Slack `users.lookupByEmail` (scope `users:read.email`). pdi never sees the e-mail; it is never
 * logged. Any failure or no match gives null with one log line saying why; kept per person like `suitePeople`.
 */
export function slackUsers(link: SuiteLink, deps: { fetch: typeof fetch; now: () => Date; log: (m: string) => void; slackBotToken: string }): FindSlackUser {
  const cache = new Map<string, { user: string | null; until: number }>();
  const now = () => deps.now().getTime();
  const call = (url: string, init: RequestInit) => deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const serviceToken = tokenSource(link, call, now);

  const lookup = async (sub: string): Promise<string> => {
    if (!UUID.test(sub)) throw new Miss('not a suite person id');
    const res = await call(`${link.identityUrl}/api/people/${sub}`, { headers: { authorization: `Bearer ${await serviceToken()}` } });
    if (res.status === 404) throw new Miss('no suite person with a verified e-mail (di-identity answered 404)');
    if (res.status === 403) throw new Error('di-identity refused: this client may not read e-mails (email: true in keycloak/suite.json)');
    if (!res.ok) throw new Error(`di-identity answered HTTP ${res.status}`);
    const email = ((await res.json()) as { email?: unknown }).email;
    if (typeof email !== 'string' || !email.includes('@')) throw new Error('di-identity gave no e-mail');
    const found = await call('https://slack.com/api/users.lookupByEmail', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${deps.slackBotToken}` },
      body: new URLSearchParams({ email }).toString(),
    });
    const body = (await found.json().catch(() => ({}))) as { ok?: boolean; error?: string; user?: { id?: string; deleted?: boolean; is_bot?: boolean } };
    if (!body.ok && body.error === 'users_not_found') throw new Miss('no Slack user with the suite e-mail');
    if (!body.ok) throw new Error(`users.lookupByEmail: ${body.error ?? `HTTP ${found.status}`}`);
    if (!body.user?.id || body.user.deleted || body.user.is_bot) throw new Miss('a deleted user or a bot in Slack');
    return body.user.id;
  };

  return async (sub: string) => {
    const hit = cache.get(sub);
    if (hit && now() < hit.until) return hit.user;
    try {
      const user = await lookup(sub);
      cache.set(sub, { user, until: now() + FOUND_TTL_MS });
      return user;
    } catch (err) {
      if (err instanceof Miss) cache.set(sub, { user: null, until: now() + MISSING_TTL_MS });
      deps.log(`Slack user for a suite person not found: ${(err as Error).message}`);
      return null;
    }
  };
}
