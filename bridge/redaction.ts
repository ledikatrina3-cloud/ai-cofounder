// Redaction для bridge/server.ts — зеркало src/observe/redaction.ts.
// Дублируется намеренно: bridge/ не должен импортировать из src/ (Electron-deps).
// При изменении регулярок — синхронизировать оба файла.
// Применяется в POST /event/:kind для событий, пришедших от claude-code-hooks
// (не AI-Cofounder, где redaction уже сделана в src/observe/bridge.ts emit()).

const KV_KEYS = '(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|BEARER)';
const KV_PATTERN = new RegExp(`(${KV_KEYS})\\s*[=:]\\s*"?([^"\\s,}]+)"?`, 'gi');

const PREFIX_TOKEN_PATTERN = /(?:^|(?<=[^A-Za-z0-9_-]))(sk-|rk_|whsec_|tok_)[A-Za-z0-9_-]{16,}/g;

const TELEGRAM_TOKEN_PATTERN = /(?<!\d)\d{8,12}:[A-Za-z0-9_-]{30,}/g;

export function redactSecrets(input: string): string {
  if (input === '') return input;
  let out = input;
  out = out.replace(KV_PATTERN, '$1=***');
  out = out.replace(PREFIX_TOKEN_PATTERN, '***');
  out = out.replace(TELEGRAM_TOKEN_PATTERN, '***');
  return out;
}
