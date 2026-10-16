function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(value)) throw new Error(`Env var ${name} must be a number`);
  return value;
}

export const config = {
  port: int('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  timezone: process.env.TZ_APP ?? 'Asia/Kolkata',
  dbPath: process.env.DB_PATH ?? './data/app.sqlite',
  webDist: process.env.WEB_DIST ?? '../web/dist',

  appPassword: required('APP_PASSWORD'),
  cookieSecret: required('COOKIE_SECRET'),

  openwaUrl: (process.env.OPENWA_URL ?? 'http://localhost:2785').replace(/\/$/, ''),
  openwaApiKey: required('OPENWA_API_KEY'),
  openwaSessionName: process.env.OPENWA_SESSION ?? 'main',

  // URL OpenWA uses to reach our webhook receiver. Leave empty to skip delivery/read tracking.
  webhookUrl: process.env.WEBHOOK_URL ?? '',
  webhookSecret: process.env.WEBHOOK_SECRET ?? '',

  // Pacing: random gap between two sends, and a hard cap per calendar day.
  minDelaySec: int('MIN_DELAY_SEC', 45),
  maxDelaySec: int('MAX_DELAY_SEC', 120),
  dailyCap: int('DAILY_CAP', 40),
  maxBatch: int('MAX_BATCH', 10),
};
