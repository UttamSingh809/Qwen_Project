// Structured JSON logging. IMPORTANT: never log passwords, password hashes,
// tokens (access or refresh), or authorization/cookie headers.

type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

const REDACTED_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'passwordhash',
  'token',
  'refreshtoken',
  'accesstoken',
  'authorization',
  'cookie',
]);

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as LogFields);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...redact(fields),
  });
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](line);
}

export const logger = {
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields ?? {}),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields ?? {}),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields ?? {}),
};
