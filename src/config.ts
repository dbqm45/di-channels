import type { Config } from './app.ts';

/** Configuration from the environment; a missing setting stops the start with its name (never its value). */
export function configFrom(env: Record<string, string | undefined>): Config {
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const url = need('DI_DEFINITION_URL');
  const u = new URL(url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new Error('DI_DEFINITION_URL must be https:// (http only for localhost)');
  const workspaces: Record<string, string> = {};
  for (const pair of (env.DI_CHANNELS_WORKSPACES ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [channel, ws] = pair.split('=').map((s) => s.trim());
    if (!channel || !ws || !/^[A-Z0-9]{2,20}$/.test(channel) || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(ws)) throw new Error(`DI_CHANNELS_WORKSPACES: "${pair}" is not CHANNEL_ID=workspace`);
    workspaces[channel] = ws;
  }
  return {
    slackSigningSecret: need('SLACK_SIGNING_SECRET'),
    slackBotToken: need('SLACK_BOT_TOKEN'),
    ...(env.SLACK_TEAM_ID?.trim() && { slackTeam: env.SLACK_TEAM_ID.trim() }),
    definition: { url, secret: need('CI_CHANNELS_SIGNING_SECRET') },
    workspaces,
    ...waitingFrom(env),
    ...suiteFrom(env),
  };
}

const httpsOrLoopback = (name: string, raw: string): string => {
  const u = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new Error(`${name} must be https:// (http only for localhost)`);
  return raw.replace(/\/+$/, '');
};

/** The suite person as author (ADR 17) is on only with the suite issuer, this app's client secret and di-identity. */
function suiteFrom(env: Record<string, string | undefined>): Pick<Config, 'suite'> {
  const issuer = env.SUITE_ISSUER?.trim();
  const secret = env.SUITE_CLIENT_SECRET?.trim();
  const identity = env.DI_IDENTITY_URL?.trim();
  if (!issuer && !secret && !identity) return {};
  if (!issuer || !secret || !identity) throw new Error('SUITE_ISSUER, SUITE_CLIENT_SECRET and DI_IDENTITY_URL go together');
  return {
    suite: {
      issuer: httpsOrLoopback('SUITE_ISSUER', issuer),
      clientId: env.SUITE_CLIENT_ID?.trim() || 'di-channels',
      clientSecret: secret,
      identityUrl: httpsOrLoopback('DI_IDENTITY_URL', identity),
    },
  };
}

/** "Waiting for you" (step 17) is on only with both the pdi secret and the approver's Slack id. */
function waitingFrom(env: Record<string, string | undefined>): Pick<Config, 'waiting'> {
  const secret = env.PDI_CHANNELS_SIGNING_SECRET?.trim();
  const approver = env.DI_CHANNELS_APPROVER?.trim();
  if (!secret && !approver) return {};
  if (!secret || !approver) throw new Error('PDI_CHANNELS_SIGNING_SECRET and DI_CHANNELS_APPROVER go together');
  if (!/^[UW][A-Z0-9]{2,20}$/.test(approver)) throw new Error('DI_CHANNELS_APPROVER must be a Slack user id (U…)');
  const timeZone = env.DI_CHANNELS_TIMEZONE?.trim() || 'Europe/Warsaw';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error('DI_CHANNELS_TIMEZONE is not a time zone');
  }
  return { waiting: { secret, approver, timeZone } };
}
