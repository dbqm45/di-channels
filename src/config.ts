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
  };
}
