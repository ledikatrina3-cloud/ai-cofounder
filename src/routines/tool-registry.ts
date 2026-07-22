// Tool registry для routines (фаза 3.1).
//
// Маппинг имён tool'ов из routine frontmatter (project.read, project.bash, ...) →
// Agent SDK builtin-инструменты ('Read', 'Bash', ...) или пометку unsupported
// (требует MCP-server, будет добавлен в M3.2+).
//
// Контракт фазы 3.1:
//   * `resolveToolMappings(tools)` — принимает tools[] из Routine.tools,
//     возвращает:
//       - sdkTools: string[] — имена SDK builtins, передаются в allowedTools.
//       - unsupportedTools: {name, reason}[] — всё, что не маппится в SDK
//         (project.db.query, project.telegram.read, journal.search, report.send).
//         Для них данные инжектируются в system prompt (M3.2+).
//
// Почему не бросать ошибку на unsupported:
//   * routine может декларировать tool, который ещё не реализован в SDK (project.db.query).
//   * Поведение деградирует gracefully: sub-agent видит данные из system prompt
//     вместо живых tool-вызовов. Лучше работающий sub-agent без части данных,
//     чем не запустившийся dispatch.

export type ToolMapping =
  | { kind: 'sdk'; sdkName: string }
  | { kind: 'unsupported'; reason: string };

/**
 * Tools, которые runtime.ts обрабатывает через pre-fetch (данные инжектируются в system prompt
 * через fetchDbContext или обрабатываются dispatcher'ом). Эти инструменты технически остаются
 * в unsupportedTools (для graceful degradation), но не показываются агенту как "недоступные"
 * — вместо этого их данные уже есть в system prompt к моменту запуска sub-agent'а.
 *
 * project.db.query — данные предзагружаются через fetchDbContext в runtime.ts.
 * report.send      — dispatcher сам отправляет output агента в Telegram (src/core/dispatcher.ts).
 * journal.search   — данные будут инжектироваться в будущей версии через fetchJournalContext.
 */
export const PREFETCHED_TOOL_NAMES = new Set(['project.db.query', 'report.send', 'journal.search']);

// Статическая таблица маппинга. Одно место изменений при появлении новых SDK-инструментов.
const TOOL_MAP: Record<string, ToolMapping> = {
  'project.read': { kind: 'sdk', sdkName: 'Read' },
  'project.grep': { kind: 'sdk', sdkName: 'Grep' },
  'project.glob': { kind: 'sdk', sdkName: 'Glob' },
  'project.bash': { kind: 'sdk', sdkName: 'Bash' },
  'project.db.query': {
    kind: 'unsupported',
    reason:
      'project.db.query требует MCP-server; данные будут инжектированы в system prompt в M3.2+',
  },
  'project.telegram.read': {
    kind: 'unsupported',
    reason: 'project.telegram.read требует MCP-server; данные будут инжектированы в M3.2+',
  },
  'journal.search': {
    kind: 'unsupported',
    reason: 'journal.search требует MCP-server; будет добавлен в M3.2+',
  },
  'report.send': {
    kind: 'unsupported',
    reason: 'report.send требует MCP-server; будет добавлен в M3.2+',
  },
};

export interface ResolvedToolMappings {
  sdkTools: string[];
  unsupportedTools: Array<{ name: string; reason: string }>;
}

/**
 * resolveToolMappings — маппит tool-имена из routine.tools в SDK builtins.
 *
 * @param tools — массив строк из Routine.tools (например, ['project.read', 'project.bash']).
 * @returns объект с двумя списками:
 *   - sdkTools: SDK builtin-имена (передаются в runSubagent.allowedTools).
 *   - unsupportedTools: tool'ы, которые не поддерживаются через SDK в этой версии.
 */
export function resolveToolMappings(tools: string[]): ResolvedToolMappings {
  const sdkTools: string[] = [];
  const unsupportedTools: Array<{ name: string; reason: string }> = [];

  for (const name of tools) {
    const mapping = TOOL_MAP[name];
    if (mapping === undefined) {
      unsupportedTools.push({ name, reason: `неизвестный tool '${name}'` });
    } else if (mapping.kind === 'sdk') {
      sdkTools.push(mapping.sdkName);
    } else {
      unsupportedTools.push({ name, reason: mapping.reason });
    }
  }

  return { sdkTools, unsupportedTools };
}
