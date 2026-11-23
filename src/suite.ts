/**
 * The suite person behind a Slack user (ADR 17 in dbqm45/pdi): the user's e-mail from Slack (`users.info`, scope
 * `users:read.email`), then `GET <di-identity>/api/people?email=` with this service's own token (client credentials of
 * the `di-channels` client in the suite realm, role `di-identity:people-reader`). The answer is `sub` and the suite
 * name; DI Definition then shows the suite person as the author of the question.
 *
 * Never blocks a question: any failure or no match gives null, and the question goes with the Slack name as before.
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

export function suitePeople(link: SuiteLink, deps: { fetch: typeof fetch; now: () => Date; log: (m: string) => void; slackBotToken: string }): FindSuitePerson {
  const cache = new Map<string, { person: SuitePerson | null; until: number }>();
  let token = '';
  let tokenUntil = 0;
  const now = () => deps.now().getTime();
  const call = (url: string, init: RequestInit) => deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });

  const serviceToken = async (): Promise<string> => {
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

  const slackEmail = async (user: string): Promise<string | null> => {
    const res = await call('https://slack.com/api/users.info', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${deps.slackBotToken}` },
      body: new URLSearchParams({ user }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; user?: { deleted?: boolean; is_bot?: boolean; profile?: { email?: string } } };
    if (!body.ok) throw new Error(`users.info: ${body.error ?? `HTTP ${res.status}`}`);
    if (body.user?.deleted || body.user?.is_bot) return null;
    return body.user?.profile?.email?.trim().toLowerCase() || null;
  };

  const lookup = async (user: string): Promise<SuitePerson | null> => {
    const email = await slackEmail(user);
    if (!email) return null;
    const res = await call(`${link.identityUrl}/api/people?email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${await serviceToken()}` } });
    if (res.status === 404) return null;
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
      cache.set(user, { person, until: now() + (person ? FOUND_TTL_MS : MISSING_TTL_MS) });
      return person;
    } catch (err) {
      deps.log(`suite person for a Slack user not found: ${(err as Error).message}`);
      return null;
    }
  };
}

/** The finder, but giving up (null) after `ms`; for the modal, which must answer Slack within 3 seconds. */
export const within = (find: FindSuitePerson, ms: number): FindSuitePerson => (user) =>
  Promise.race([find(user), new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);
