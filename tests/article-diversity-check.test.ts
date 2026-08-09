import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function writeArticle(dir: string, name: string, body: string) {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, body);
  return file;
}

describe('article diversity check', () => {
  it('rejects a repeated one-object/status/exceptions/pilot skeleton', () => {
    const dir = mkdtempSync(join(tmpdir(), 'article-diversity-'));

    writeArticle(
      dir,
      'recent-a',
      [
        '# Оплата потерялась раньше, чем руководитель увидел счет',
        '## Передайте счет в пяти полях',
        '## Один счет за рабочий день',
        '## Обещание клиента еще не стало задачей',
        '## Автоматизация начинается с исключений',
        '## Когда пора связывать системы',
        '## Письмо руководителю на один экран',
      ].join('\n\n'),
    );

    writeArticle(
      dir,
      'recent-b',
      [
        '# Новый бот ускорит хаос, если согласование уже зависло',
        '## Согласовано еще не значит передано в работу',
        '## Карточка одного решения помещается в сообщение',
        '## Движение в чате легко спутать с движением работы',
        '## Напоминание работает лишь после правила эскалации',
        '## Пилот нужен, чтобы проверить передачу решения',
        '## Пора автоматизировать, когда коллега поймет правило без вас',
      ].join('\n\n'),
    );

    writeArticle(
      dir,
      'recent-c',
      [
        '# Остатки: почему 5 ошибок точной таблицы бьют по продажам',
        '## Ошибка появляется между полкой и строкой',
        '## Проведите 1 товар через 4 события',
        '## Когда таблицу ещё рано заменять',
        '## Когда пора проверять автоматизацию на пилоте',
        '## Маленький пилот обязан замечать расхождения',
        '## Отправьте специалисту этот короткий бриф',
      ].join('\n\n'),
    );

    const candidate = writeArticle(
      dir,
      'candidate',
      [
        '# Заказы копятся быстрее, когда автоматизируют очередь',
        'Проведите 1 заказ через 4 передачи и найдите 2 очереди.',
        '## Проведите один заказ через четыре передачи',
        '## Статус обязан отвечать на следующий вопрос',
        '## Исключения показывают настоящую работу',
        '## Автоматизация нужна там, где правило уже можно проверить',
        '## Остановитесь, если очередь пока нельзя объяснить',
      ].join('\n\n'),
    );

    expect(() =>
      execFileSync('node', ['scripts/article-diversity-check.mjs', candidate, '--content-dir', dir], {
        cwd: process.cwd(),
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
