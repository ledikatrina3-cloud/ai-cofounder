// Conversational handler для Telegram-бота: фаундер пишет любой текст —
// бот проксирует его в Claude Code sub-agent (через runSubagent), агент работает
// с целевым проектом (cwd, file-tools, Bash) и возвращает ответ в Telegram.
//
// Сессии: история переписки хранится в Record-таблице (см. src/chat/sessions.ts).
// При каждом сообщении строится prompt со всей историей текущей сессии (либо
// summary, если был /compact, + новые turn'ы). Сессия живёт 30 минут после
// последнего сообщения, потом следующее сообщение откроет новую.

import { ulid } from 'ulid';
import {
  appendAssistantMessage,
  appendUserMessage,
  getCurrentSessionId,
  getSessionHistory,
  startNewSession,
} from '../chat/sessions.js';
import type { PrismaClient } from '../db/client.js';
import { runSubagent } from '../llm/subagent.js';
import { emit } from '../observe/bridge.js';
import { loadProjectMap } from '../projects/map.js';
import { getProject } from '../projects/registry.js';

export interface ChatReply {
  text: string;
  durationMs: number;
  usd: number;
  status: 'ok' | 'failed' | 'timeout';
  sessionId: string;
}

// Дефолтный проект, в который проксируются conversational-сообщения.
// Поменяй на id своего основного проекта из config/projects.md.
const DEFAULT_PROJECT_ID = 'example-project';
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TURNS = 15;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

export async function handleChatMessage(
  chatId: number,
  userText: string,
  db?: PrismaClient,
): Promise<ChatReply> {
  // 1. Определяем активную сессию или создаём новую.
  let sessionId = await getCurrentSessionId(chatId, db);
  if (sessionId === null) {
    sessionId = await startNewSession(chatId, db);
  }

  // 2. Загружаем проект и карту.
  const project = await getProject(DEFAULT_PROJECT_ID);
  if (project === null || !project.enabled) {
    const errorText =
      project === null
        ? `❌ проект '${DEFAULT_PROJECT_ID}' не найден в config/projects.md`
        : `❌ проект '${project.id}' отключён (path не существует или enabled=false)`;
    await appendUserMessage(chatId, sessionId, userText, db);
    await appendAssistantMessage(
      chatId,
      sessionId,
      { text: errorText, usd: 0, durationMs: 0, status: 'failed' },
      db,
    );
    return { text: errorText, durationMs: 0, usd: 0, status: 'failed', sessionId };
  }
  const projectMap = await loadProjectMap(project.id);

  // 3. Грузим историю текущей сессии (summary + последние turn'ы).
  const history = await getSessionHistory(sessionId, db);

  // 4. Сохраняем входящее сообщение СРАЗУ (чтобы при падении агента не потерять).
  await appendUserMessage(chatId, sessionId, userText, db);

  // 5. Строим prompt и system prompt.
  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildSystemPrompt(project.name, today, projectMap);
  const userPrompt = buildUserPrompt(history, userText);

  // 6. Запускаем sub-agent. Оборачиваем в subagent.start/end — Bridge UI
  // переводит Brain в thinking/executing и линкует chat-сессию через
  // parentSession=sessionId.
  const subagentId = ulid();
  await emit({
    type: 'subagent.start',
    subagentId,
    subagentType: 'chat',
    parentSession: sessionId,
  });
  const subagentStartedAt = Date.now();
  try {
    const result = await runSubagent({
      promptId: 'telegram:chat',
      prompt: userPrompt,
      systemPrompt,
      model: DEFAULT_MODEL,
      cwd: project.path,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTurns: DEFAULT_MAX_TURNS,
    });

    const text = extractText(result.messages);
    const status: ChatReply['status'] = result.timedOut
      ? 'timeout'
      : result.result?.is_error === true
        ? 'failed'
        : 'ok';
    const usd = result.result?.total_cost_usd ?? 0;
    const replyText =
      text.trim().length > 0
        ? text
        : status === 'timeout'
          ? '⏱️ тайм-аут 90с — запрос слишком сложный, разбей на части'
          : '⚠️ агент завершился без ответа';

    await appendAssistantMessage(
      chatId,
      sessionId,
      { text: replyText, usd, durationMs: result.durationMs, status },
      db,
    );

    const totalTokens =
      (result.result?.usage?.input_tokens ?? result.result?.usage?.inputTokens ?? 0) +
      (result.result?.usage?.output_tokens ?? result.result?.usage?.outputTokens ?? 0);
    await emit({
      type: 'subagent.end',
      subagentId,
      durationMs: Date.now() - subagentStartedAt,
      verdict: status === 'ok' ? 'code' : status === 'timeout' ? 'unclear' : 'human',
      totalUsd: usd,
      totalTokens,
      timedOut: result.timedOut,
    });

    return { text: replyText, durationMs: result.durationMs, usd, status, sessionId };
  } catch (err) {
    const errorText = `❌ ошибка: ${err instanceof Error ? err.message : String(err)}`;
    await appendAssistantMessage(
      chatId,
      sessionId,
      { text: errorText, usd: 0, durationMs: 0, status: 'failed' },
      db,
    );
    await emit({
      type: 'subagent.end',
      subagentId,
      durationMs: Date.now() - subagentStartedAt,
      verdict: 'human',
      totalUsd: 0,
      totalTokens: 0,
      timedOut: false,
    });
    return { text: errorText, durationMs: 0, usd: 0, status: 'failed', sessionId };
  }
}

function buildSystemPrompt(
  projectName: string,
  today: string,
  projectMap: Awaited<ReturnType<typeof loadProjectMap>>,
): string {
  const lines: string[] = [
    `Ты — AI-кофаундер для проекта ${projectName}. Сегодня ${today}.`,
    'Фаундер пишет тебе из Telegram. Твоя задача — помочь конкретно по его запросу.',
    '',
    '## Карта проекта',
  ];
  if (projectMap.description) {
    lines.push(`**Описание:** ${projectMap.description}`);
    lines.push('');
  }
  if (projectMap.keyDirectories.length > 0) {
    lines.push('**Ключевые директории:**');
    for (const d of projectMap.keyDirectories) {
      lines.push(`- ${d.path}${d.note ? `: ${d.note}` : ''}`);
    }
    lines.push('');
  }
  if (projectMap.keyFiles.length > 0) {
    lines.push('**Ключевые файлы:**');
    for (const f of projectMap.keyFiles) {
      lines.push(`- ${f.path}${f.note ? `: ${f.note}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Правила');
  lines.push('- Отвечай кратко и по делу — это Telegram, не длинный отчёт.');
  lines.push('- Используй Read / Grep / Glob / Bash чтобы реально лезть в проект, не выдумывай.');
  lines.push('- Если запрос неоднозначен — задай уточняющий вопрос.');
  lines.push(
    '- Markdown работает: *жирный*, _курсив_, `inline code`, [links](url). Используй для читаемости.',
  );
  lines.push(
    '- Следи за балансом: незакрытая * или _ ломает Telegram-парсер. В случае сомнений — пиши без markdown.',
  );
  return lines.join('\n');
}

function buildUserPrompt(
  history: Awaited<ReturnType<typeof getSessionHistory>>,
  newUserText: string,
): string {
  const parts: string[] = [];
  if (history.summary !== null && history.summary.length > 0) {
    parts.push("## Контекст сессии (сжатое summary предыдущих turn'ов)");
    parts.push(history.summary);
    parts.push('');
  }
  if (history.turns.length > 0) {
    parts.push('## Предыдущая переписка в этой сессии');
    for (const turn of history.turns) {
      const role = turn.role === 'user' ? 'ФАУНДЕР' : 'ТЫ ОТВЕТИЛ';
      parts.push(`### ${role}`);
      parts.push(turn.text);
      parts.push('');
    }
  }
  parts.push('## Новое сообщение фаундера');
  parts.push(newUserText);
  return parts.join('\n');
}

function extractText(messages: ReadonlyArray<unknown>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.type !== 'assistant') continue;
    const msgRecord = msg.message as Record<string, unknown> | undefined;
    const content = msgRecord?.content ?? msg.content;
    if (!Array.isArray(content)) continue;
    const textParts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text);
      }
    }
    if (textParts.length > 0) return textParts.join('\n');
  }
  return '';
}
