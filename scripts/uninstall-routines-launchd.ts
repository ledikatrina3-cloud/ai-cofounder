// Удаление plist'ов для routines из ~/Library/LaunchAgents/.
//
// Находит все файлы по паттерну `com.ai-cofounder.routine-*.plist`
// в ~/Library/LaunchAgents/ и удаляет их.
//
// НЕ ВЫЗЫВАЕТ launchctl unload — выводит инструкции для фаундера,
// который сам выполнит unload перед удалением (или после, если job неактивен).
//
// Принципы CLAUDE.md:
//   * «Не деплоить без явной команды» — launchctl всегда руками.
//   * Glob через fast-glob (уже в зависимостях).

import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import fg from 'fast-glob';

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PATTERN = 'com.ai-cofounder.routine-*.plist';

async function main(): Promise<void> {
  const files = await fg(PATTERN, {
    cwd: LAUNCH_AGENTS_DIR,
    absolute: true,
    onlyFiles: true,
  });

  if (files.length === 0) {
    console.log(`Нет plist'ов по паттерну '${PATTERN}' в ${LAUNCH_AGENTS_DIR}.`);
    return;
  }

  console.log(`Найдено ${files.length} plist'(ов):`);
  for (const f of files) {
    console.log(`  ${f}`);
  }
  console.log('');

  // Сначала — инструкции по unload (перед удалением файлов).
  console.log('Если jobs ещё активны — выполни unload РУКАМИ:');
  for (const f of files) {
    console.log(`  launchctl unload ${f}`);
  }
  console.log('');

  // Удаляем файлы.
  for (const f of files) {
    rmSync(f);
    console.log(`✓ удалён: ${f}`);
  }

  console.log('');
  console.log('Готово. Проверь, что jobs выгружены:');
  console.log('  launchctl list | grep ai-cofounder.routine');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
