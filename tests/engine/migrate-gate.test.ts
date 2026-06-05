// Version-gate раннера миграций пользовательского слоя (scripts/migrate.ts).
// Доказывает, что миграция применяется РОВНО ОДИН раз: на апгрейде с версии
// ниже её appliesUpToVersion — и уже НЕ выбирается при повторном прогоне.

import { describe, expect, it } from 'vitest';
import { cmpSemver, pendingMigrations } from '../../scripts/migrate.js';

const noop = async (): Promise<void> => {};

describe('migrate version-gate', () => {
  it('cmpSemver упорядочивает корректно (и терпит недостающие сегменты)', () => {
    expect(cmpSemver('1.0.0', '1.1.0')).toBe(-1);
    expect(cmpSemver('1.1.0', '1.0.0')).toBe(1);
    expect(cmpSemver('1.0.0', '1.0.0')).toBe(0);
    expect(cmpSemver('1.2', '1.2.0')).toBe(0);
    expect(cmpSemver('2.0.0', '1.9.9')).toBe(1);
  });

  it('первый прогон (last=null) выбирает все миграции', () => {
    const migs = [{ appliesUpToVersion: '1.1.0', description: 'x', run: noop }];
    expect(pendingMigrations(null, migs)).toHaveLength(1);
  });

  it('миграция применяется ровно один раз: нужна при апгрейде с <X, не нужна на повторе', () => {
    const migs = [{ appliesUpToVersion: '1.1.0', description: 'bump', run: noop }];
    // апгрейд с 1.0.0 → миграция нужна
    expect(pendingMigrations('1.0.0', migs)).toHaveLength(1);
    // повторный прогон, state уже зафиксирован на 1.1.0 → миграция НЕ выбирается
    expect(pendingMigrations('1.1.0', migs)).toHaveLength(0);
    // и на более поздней версии тоже нет
    expect(pendingMigrations('1.2.0', migs)).toHaveLength(0);
  });

  it('v1.0: пустой список миграций — ничего не выбирается', () => {
    expect(pendingMigrations(null, [])).toHaveLength(0);
    expect(pendingMigrations('1.0.0', [])).toHaveLength(0);
  });
});
