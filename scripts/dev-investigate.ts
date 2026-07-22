// Ручной разовый прогон sub-agent-исследователя — фаза 2.3a.
//
// Использование:
//   pnpm dev:investigate <intent.problem.id>
//
// Что делает:
//   1. Грузит config/investigate.md (targetProjectPath + лимиты).
//   2. Грузит intent.problem по id из журнала (Record).
//   3. Грузит привязанные event.support.message через RecordLink linkType='породило'.
//   4. Запускает Claude Agent SDK через runSubagent() с cwd=targetProjectPath,
//      allowedTools=[Read,Grep,Glob,Bash], whitelist Bash.
//   5. Парсит финальный finish_investigation JSON в InvestigationResult.
//   6. Пишет audit.spend (через subagent.ts), эмитит Bridge subagent.start/end.
//
// ВАЖНО:
//   * НЕ создаёт intent.diagnosis Record — это 2.3c.
//   * НЕ делает fan-out — это 2.3b.
//   * Если targetProjectPath не существует — упадёт с понятной ошибкой.
//     Положи репозиторий проекта (например, ${PROJECTS_ROOT}/example-project) или обнови
//     config/investigate.md.
//   * Touchpoint с реальным Anthropic API — съест ~$0.05-$0.20 за один прогон.
//     Агент сам этот скрипт НЕ запускает; запускает фаундер вручную.

import { disposePrisma, getPrisma } from '../src/db/client.js';
import { investigateProblem } from '../src/investigate/run.js';

async function main(): Promise<void> {
  const problemId = process.argv[2];
  if (problemId === undefined || problemId.length === 0) {
    console.error('Использование: pnpm dev:investigate <intent.problem.id>');
    process.exit(2);
  }

  const db = getPrisma();
  try {
    const result = await investigateProblem(problemId, { db });
    console.log('');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await disposePrisma();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
