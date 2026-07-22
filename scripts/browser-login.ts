// Wizard первичного логина: открывает видимое окно браузера с persistent-
// profile'ом, ждёт пока фаундер залогинится руками, потом закрывает контекст
// (что триггерит сохранение куки в userDataDir на диск).
//
// Использование:
//   pnpm browser:login <platform> [account]
//   pnpm browser:login vc main
//   pnpm browser:login reddit secondary
//
// platform — vc | dzen | reddit | linkedin. Это же имя ожидает publisher
// (`src/publish/<platform>.ts`).
// account — необязательно, default 'main'.
//
// Wizard НЕ автоматизирует логин (нет ввода паролей агентом). Цель — ровно
// «открыть окно, дать руками всё сделать, сохранить профиль».

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { openSession } from '../src/browser/session.js';

const PLATFORM_URLS: Record<string, string> = {
  vc: 'https://vc.ru/',
  dzen: 'https://dzen.ru/',
  reddit: 'https://www.reddit.com/',
  linkedin: 'https://www.linkedin.com/',
};

async function main(): Promise<void> {
  const platform = process.argv[2];
  const account = process.argv[3] ?? 'main';

  if (platform === undefined || platform === '') {
    console.error('Использование: pnpm browser:login <platform> [account]');
    console.error(`Платформы: ${Object.keys(PLATFORM_URLS).join(', ')}`);
    process.exit(1);
  }

  const url = PLATFORM_URLS[platform];
  if (url === undefined) {
    console.error(`Неизвестная платформа: '${platform}'`);
    console.error(`Доступно: ${Object.keys(PLATFORM_URLS).join(', ')}`);
    process.exit(1);
  }

  console.log(`▶ открываю ${platform} для аккаунта '${account}'…`);
  const session = await openSession({
    platform,
    account,
    headless: false,
  });

  console.log(`  профиль: ${session.profile.path}`);
  console.log(`  preexisted: ${session.profile.preexisted}`);
  console.log('');

  await session.page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Зайди в аккаунт руками в открывшемся окне.');
  console.log('  После того как залогинился, вернись сюда и нажми Enter.');
  console.log('  Если хочешь отменить — Ctrl+C.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question('[ждать Enter] ');
  rl.close();

  // Снимаем финальный URL и куки count — диагностика что сессия точно есть.
  const finalUrl = session.page.url();
  const cookies = await session.context.cookies();
  console.log('');
  console.log(`  финальный URL:  ${finalUrl}`);
  console.log(`  всего куки:     ${cookies.length}`);
  console.log('');
  console.log('  закрываю браузер — это сохранит профиль на диск…');

  await session.close();

  console.log('✓ профиль сохранён. Запустить публикацию:');
  console.log(`    pnpm publish ${platform} <путь-к-черновику.md>`);
}

main().catch((err: unknown) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
