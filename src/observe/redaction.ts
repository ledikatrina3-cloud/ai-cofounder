// Redaction layer для исходящего потока в Bridge.
// Источник правды: bridge/server.ts L280-289.
// Применяется в src/observe/bridge.ts ПЕРЕД сериализацией в JSON и POST.
//
// Принцип: маски — string→string на сериализованном JSON всего события (не
// per-field), потому что секреты могут лежать в любом nested-поле (input,
// output, properties.text, args[]). Это дешевле и надёжнее, чем рекурсивный
// обход с typed-walker'ом, и не требует знания конкретного shape события.
//
// Что маскируется:
//   1. KEY=VALUE / KEY: VALUE для известных имён (API_KEY, SECRET, TOKEN,
//      PASSWORD, DATABASE_URL, BEARER) — заменяется на 'KEY=***'.
//   2. Префиксированные строковые токены (sk-, rk_, whsec_, tok_) длиной ≥16 —
//      на '***'. Это формат API-ключей Stripe/OpenAI/Anthropic/etc.
//   3. Telegram bot tokens вида '<digits>:<35+ base64url chars>' — на '***'.
//      Не из мостик.md L280, но обязательно для allowlist'а 1.2 (бот пишется
//      в Keychain, но в логах/событиях может всплыть в URL'е sendMessage).
//
// Чего НЕ маскируем:
//   * ULID'ы (recordId, idempotencyKey, sessionId) — они не секрет, а
//     устойчивые идентификаторы для трассировки. Если в проде ULID-ом окажется
//     actorRef'ом чувствительной Записи — visibility='secret' защищает её на
//     уровне БД (правила-нерушимые.md:55), не маскированием в логе.
//   * Email/телефон фаундера — выходит за scope мостика; добавим, когда
//     M2 начнёт прокачивать сообщения клиентов.

const KV_KEYS = '(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|BEARER)';
// Маскируем VALUE до конца JSON-строки/значения, исключая закрывающую кавычку.
const KV_PATTERN = new RegExp(`(${KV_KEYS})\\s*[=:]\\s*"?([^"\\s,}]+)"?`, 'gi');

// sk-..., rk_..., whsec_..., tok_... ≥16 base64url chars.
// (?<!\w) — отрезает префиксы вроде "tok_a" внутри идентификатора, оставляя только
// «настоящие» начала с границы слова или символа. Не идеально (\w включает _ и
// цифры, поэтому пометка `tok_xxx` после `_` всё-таки сматчится — это OK,
// мы скорее over-redact'нем чем пропустим).
const PREFIX_TOKEN_PATTERN = /(?:^|(?<=[^A-Za-z0-9_-]))(sk-|rk_|whsec_|tok_)[A-Za-z0-9_-]{16,}/g;

// Telegram bot token: 8-12 цифр, двоеточие, 30+ символов из base64url (Telegram
// использует A-Za-z0-9_-, длина обычно 35). Якоря `\b` не используем: токен
// часто встречается внутри URL после префикса `bot` (api.telegram.org/bot<token>),
// где `t1234` не даёт word-boundary. Жадная {30,} в классе сама ограничит хвост.
const TELEGRAM_TOKEN_PATTERN = /(?<!\d)\d{8,12}:[A-Za-z0-9_-]{30,}/g;

export function redactSecrets(input: string): string {
  if (input === '') return input;
  let out = input;
  out = out.replace(KV_PATTERN, '$1=***');
  out = out.replace(PREFIX_TOKEN_PATTERN, '***');
  out = out.replace(TELEGRAM_TOKEN_PATTERN, '***');
  return out;
}
