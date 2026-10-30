// Centralised environment configuration with fail-fast validation.
// Secrets are NEVER hardcoded; they come from the environment (see .env.example).

export interface AppConfig {
  nodeEnv: string;
  isProd: boolean;
  isTest: boolean;
  port: number;
  jwtAccessSecret: string;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  corsOrigins: string[];
  databaseUrl: string;
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';
  const secret = required('JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET);
  if (isProd && secret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET must be at least 32 characters in production');
  }
  return {
    nodeEnv,
    isProd,
    isTest: nodeEnv === 'test',
    port: Number(env.PORT ?? 4000),
    jwtAccessSecret: secret,
    accessTokenTtlMinutes: Number(env.ACCESS_TOKEN_TTL_MINUTES ?? 15),
    refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    // Production CORS must be configured explicitly via CORS_ORIGIN (comma separated).
    corsOrigins: (env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
    databaseUrl: required('DATABASE_URL', env.DATABASE_URL),
  };
}

export const config = loadConfig();
