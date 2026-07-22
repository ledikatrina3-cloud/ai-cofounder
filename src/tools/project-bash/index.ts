// Tool: project.bash — read-only Bash в проекте с whitelist-фильтрацией.
//
// Фаза 2.2 (W2' ветка B). Документация: plans/.
//
// Что делает projectBash:
//   1. Проверяет, что команда начинается с одного из prefix-паттернов whitelist.
//   2. Проверяет, что команда не содержит запрещённые substrings (инъекции).
//   3. Запускает команду через execFile('/bin/sh', ['-c', cmd]) с cwd = projectPath.
//   4. Возвращает BashResult {stdout, stderr, exitCode}.
//      * exitCode != 0 → возвращаем BashResult (не бросаем — caller видит exitCode).
//      * timeout → ProjectBashTimeoutError.
//
// Что НЕ делает:
//   * НЕ пишет audit-записи — это задача caller'а (routine runtime, фаза 3.1+).
//   * НЕ интегрируется с Agent SDK напрямую — tool-registry это сделает в фазе 3.1.
//   * НЕ читает карту проекта — whitelist передаётся явно или берётся как DEFAULT_WHITELIST.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Публичный контракт.
// ---------------------------------------------------------------------------

export interface BashOptions {
  /** prefix-паттерны. Если не передан — DEFAULT_WHITELIST. */
  whitelist?: string[];
  /** default: 30_000 мс */
  timeoutMs?: number;
  /** default: 512_000 байт (512 KB) */
  maxOutputBytes?: number;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Иерархия ошибок.
// ---------------------------------------------------------------------------

export class ProjectBashError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
  ) {
    super(`project.bash: ${message}`);
    this.name = 'ProjectBashError';
  }
}

export class ProjectBashPermissionError extends ProjectBashError {
  constructor(cmd: string, reason: string) {
    super('project.bash', `команда заблокирована: '${cmd}' — ${reason}`);
    this.name = 'ProjectBashPermissionError';
  }
}

export class ProjectBashTimeoutError extends ProjectBashError {
  constructor(cmd: string, timeoutMs: number) {
    super('project.bash', `тайм-аут ${timeoutMs}ms на команду: '${cmd}'`);
    this.name = 'ProjectBashTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Whitelist и запрещённые паттерны.
// ---------------------------------------------------------------------------

export const DEFAULT_WHITELIST: readonly string[] = [
  'git log',
  'git show',
  'git blame',
  'git diff',
  'git status',
  'git branch',
  'cat',
  'head',
  'tail',
  'wc',
  'find',
  'ls',
  'rg',
  'grep',
  'pwd',
];

/**
 * Запрещённые substring-паттерны — проверяются ПОСЛЕ whitelist.
 * Чистый substring-match (без word-boundary) — для метасимволов и редко
 * используемых внутри args токенов.
 */
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  '>', // любой redirect: >file, >>file, 2>, 2>>
  '&&',
  '||',
  '|', // pipe
  ';', // command separator — без пробелов shell всё равно выполнит вторую команду
  '\n', // newline injection: /bin/sh -c "cmd1\ncmd2" выполняет обе команды
  '\r', // carriage return — аналогично
  '`', // backtick subshell
  '$(', // $() subshell
];

/**
 * Запрещённые «слова» — проверяются как отдельный токен в args (между
 * non-alnum boundaries). Не блокируют легитимные args вроде `--platform`
 * (содержит `rm`) или `--execute` (содержит `exec`).
 *
 * Раньше — substring-проверка вида `args.includes('rm')` ложно срабатывала
 * на `--platform`, `--format` и т.п., из-за чего легитимные skill-команды
 * блокировались, а злоумышленник мог обойти проверку, замаскировав `rm`
 * внутри другого слова. Word-boundary решает оба случая.
 */
const FORBIDDEN_WORDS: readonly string[] = ['rm', 'eval', 'curl', 'wget', 'nc', 'ncat', 'ssh'];

/**
 * Опасные find-примитивы — ломают read-only-контракт. `find -exec`/`-execdir`/
 * `-ok` запускают ПРОИЗВОЛЬНУЮ команду (включая sh/touch/mv/dd, которых нет в
 * FORBIDDEN_WORDS); `-delete` удаляет; `-fprintf`/`-fprint`/`-fls` пишут файл.
 * Блокируем как standalone-токены (filename'ы ими быть не могут).
 */
const FIND_DANGEROUS_PRIMARIES: ReadonlySet<string> = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprintf',
  '-fprint',
  '-fprint0',
  '-fls',
]);

/**
 * Absolute-path regex. Ловит `/path` в начале args, после whitespace, или
 * после `=`, `:`, `"`, `'` (т.е. в значении опции).
 */
const ABSOLUTE_PATH_RE = /(?:^|[\s="':])\/[A-Za-z0-9_.\\-]/;

/**
 * Path-traversal через СЕГМЕНТЫ пути (надёжнее regex'а: прошлый
 * `[^A-Za-z0-9_./\\-]` ИСКЛЮЧАЛ `/` из границы, поэтому `x/../../etc` проходил).
 * Бьём args на токены, каждый — на сегменты по `/` и `\`, и реджектим любой
 * сегмент, равный ровно `..`. Ловит `../f`, `x/../../etc`, `--out=../f`, `..`
 * в конце токена; НЕ ловит легитимные `..foo`/`v1..2`/`a.b..c` (там сегмент не `..`).
 */
function hasTraversalSegment(args: string): boolean {
  for (const token of args.split(/[\s="':,()]+/)) {
    if (token.length === 0) continue;
    for (const seg of token.split(/[/\\]/)) {
      if (seg === '..') return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Публичная функция проверки команды (экспортируется для тестов и tool-registry).
// ---------------------------------------------------------------------------

/**
 * canRunCommand — проверяет, что команда разрешена.
 *
 * Алгоритм:
 *   1. Trim. Проверить, что начинается с одного из whitelist-префиксов.
 *   2. Проверить, что не содержит запрещённые substrings.
 *
 * @returns true — команда разрешена; false — заблокирована.
 *
 * Примечание: функция не бросает — только возвращает boolean.
 * projectBash использует эту функцию и бросает ProjectBashPermissionError
 * при false.
 */
export function canRunCommand(cmd: string, whitelist?: string[]): boolean {
  const list = whitelist ?? DEFAULT_WHITELIST;
  const trimmed = cmd.trim();

  // 1. Проверка whitelist — команда должна начинаться с одного из префиксов.
  //    Берём САМЫЙ ДЛИННЫЙ matching prefix (важно для skill-prefixes вида
  //    `pnpm exec tsx skills/<name>/scripts/<file>.ts` — без этого
  //    подкралось бы fallback на короткий "pnpm" префикс из расширения).
  let matchedPrefix: string | null = null;
  for (const prefix of list) {
    if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) {
      if (matchedPrefix === null || prefix.length > matchedPrefix.length) {
        matchedPrefix = prefix;
      }
    }
  }
  if (matchedPrefix === null) return false;

  // 2. Проверки только в части ПОСЛЕ matched prefix (args). Префикс — это уже
  //    доверенная точка входа (либо DEFAULT_WHITELIST, либо routine/skill
  //    whitelist). Иначе skill-prefix `pnpm exec tsx skills/...` ложно
  //    срабатывал бы на forbidden substring 'exec' внутри самого префикса.
  const args = trimmed.slice(matchedPrefix.length);
  if (!argsAreSafe(args)) return false;

  return true;
}

/**
 * Проверяет args на запрещённые substrings/words/path-traversal/абсолютные
 * пути. Возвращает true если args безопасны.
 *
 * Вынесено отдельно, чтобы canRunCommand и projectBash использовали одну
 * проверку (раньше было два copy-paste с расхождениями).
 */
function argsAreSafe(args: string): boolean {
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    if (args.includes(forbidden)) return false;
  }
  // Word-boundary check для опасных команд (rm/eval/curl/...).
  for (const word of FORBIDDEN_WORDS) {
    if (containsWord(args, word)) return false;
  }
  // find-примитивы, ломающие read-only (`-delete`/`-exec`/`-fprintf`/...).
  if (hasDangerousFindPrimary(args)) return false;
  // Path-traversal: любой сегмент пути, равный `..`, в любой позиции args
  // (включая `x/../../etc`, `--out=../foo`, `--out="../foo"`).
  if (hasTraversalSegment(args)) return false;
  // Абсолютные пути: `/foo` в начале args, после whitespace, после `=`/`:`/кавычек.
  if (ABSOLUTE_PATH_RE.test(args)) return false;
  return true;
}

/** Реджектит `find ... -delete/-exec/...` — standalone-токен опасного примитива. */
function hasDangerousFindPrimary(args: string): boolean {
  for (const token of args.split(/\s+/)) {
    if (FIND_DANGEROUS_PRIMARIES.has(token)) return true;
  }
  return false;
}

/**
 * Проверяет, содержится ли `word` в `s` как самостоятельный токен (граница
 * слова — non-alphanumeric до и после). Не срабатывает на `--platform` для
 * word='rm', потому что `r` в `rm` следует за `o`.
 */
function containsWord(s: string, word: string): boolean {
  let idx = 0;
  while (idx < s.length) {
    const found = s.indexOf(word, idx);
    if (found === -1) return false;
    const before = found === 0 ? '' : (s[found - 1] ?? '');
    const after = found + word.length >= s.length ? '' : (s[found + word.length] ?? '');
    const isBoundary = (ch: string): boolean => ch === '' || !/[A-Za-z0-9_]/.test(ch);
    if (isBoundary(before) && isBoundary(after)) return true;
    idx = found + 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

/**
 * projectBash — запускает read-only команду в директории projectPath.
 *
 * @param projectPath — абсолютный путь к директории проекта (cwd для команды).
 * @param cmd — команда для запуска.
 * @param options — whitelist, timeout, maxOutputBytes.
 *
 * @throws ProjectBashPermissionError — команда не прошла whitelist/injection-проверку.
 * @throws ProjectBashTimeoutError — команда превысила timeoutMs.
 * @returns BashResult — {stdout, stderr, exitCode} (exitCode != 0 не бросает).
 */
export async function projectBash(
  projectPath: string,
  cmd: string,
  options: BashOptions = {},
): Promise<BashResult> {
  const { whitelist, timeoutMs = 30_000, maxOutputBytes = 512_000 } = options;
  const list = whitelist ?? DEFAULT_WHITELIST;
  const trimmed = cmd.trim();

  // 1. Проверка whitelist. Берём самый длинный matching prefix.
  let matchedPrefix: string | null = null;
  for (const prefix of list) {
    if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) {
      if (matchedPrefix === null || prefix.length > matchedPrefix.length) {
        matchedPrefix = prefix;
      }
    }
  }
  if (matchedPrefix === null) {
    throw new ProjectBashPermissionError(
      cmd,
      'не в whitelist (разрешены только read-only команды)',
    );
  }

  // 2. Проверка args на injection/traversal/абсолютные пути — единая для
  //    canRunCommand и projectBash (см. argsAreSafe). Для понятной ошибки
  //    fallback-проверяем категорию вручную.
  const args = trimmed.slice(matchedPrefix.length);
  if (!argsAreSafe(args)) {
    let reason = 'args содержат запрещённый паттерн';
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      if (args.includes(forbidden)) {
        reason = `содержит запрещённый паттерн: '${forbidden}'`;
        break;
      }
    }
    for (const word of FORBIDDEN_WORDS) {
      if (containsWord(args, word)) {
        reason = `содержит запрещённую команду: '${word}'`;
        break;
      }
    }
    if (hasDangerousFindPrimary(args)) {
      reason = 'опасный find-примитив (-delete/-exec/-fprintf): ломает read-only';
    } else if (hasTraversalSegment(args)) {
      reason = 'содержит path-traversal (`..`) в аргументах';
    } else if (ABSOLUTE_PATH_RE.test(args)) {
      reason = 'абсолютные пути запрещены — используй относительные пути внутри проекта';
    }
    throw new ProjectBashPermissionError(cmd, reason);
  }

  // 3. Запуск через execFile.
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', cmd], {
      cwd: projectPath,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    // Проверяем, был ли тайм-аут (Node.js ставит killed=true при timeout).
    if (isTimeoutError(err)) {
      throw new ProjectBashTimeoutError(cmd, timeoutMs);
    }

    // Ненулевой exitCode — возвращаем BashResult, не бросаем.
    const exitErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (exitErr.code !== undefined && exitErr.code !== 'ETIMEDOUT') {
      const exitCode =
        typeof exitErr.code === 'number' ? exitErr.code : Number.parseInt(String(exitErr.code), 10);
      return {
        stdout: exitErr.stdout ?? '',
        stderr: exitErr.stderr ?? '',
        exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
      };
    }

    // Прочие ошибки (например, ENOENT /bin/sh) — перебрасываем как ProjectBashError.
    const message = err instanceof Error ? err.message : String(err);
    throw new ProjectBashError('project.bash', `ошибка execFile: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Внутренняя утилита.
// ---------------------------------------------------------------------------

function isTimeoutError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  // Node.js child_process при timeout ставит killed=true + signal='SIGTERM'
  // или code='ETIMEDOUT'. Проверяем оба признака.
  return e.killed === true || e.code === 'ETIMEDOUT';
}
