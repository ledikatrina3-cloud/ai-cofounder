import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('product topic frame', () => {
  const productKnowledge = readFileSync(resolve(process.cwd(), 'org/product-knowledge.md'), 'utf8');
  const normalizedProductKnowledge = productKnowledge.toLowerCase();
  const audience = readFileSync(resolve(process.cwd(), 'org/audience.md'), 'utf8');

  it('keeps HR as the first focus but expands topic sources beyond HR', () => {
    expect(audience).toContain('Первый маркетинговый фокус');
    expect(audience).toContain('HR/кадровик в малом бизнесе');

    for (const phrase of [
      'заявки и клиентские сообщения',
      'счета, акты, оплаты',
      'записи, расписания и администраторы',
      'остатки, заказы и простая складская рутина',
      'не заменяет CRM, ERP или бухгалтерскую систему',
    ]) {
      expect(normalizedProductKnowledge).toContain(phrase.toLowerCase());
    }
  });
});
