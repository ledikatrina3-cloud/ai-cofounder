import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../bridge/app/src/components/Office/RoutineDetailDrawer.tsx', import.meta.url),
  'utf8',
);

describe('RoutineDetailDrawer refresh', () => {
  it('periodically reloads recent runs while the drawer stays open', () => {
    expect(source).toContain('const DETAIL_REFRESH_MS = 5000');
    expect(source).toContain('const detailInterval = window.setInterval');
    expect(source).toContain('if (firstLoad) setLoading(true)');
    expect(source).toContain('window.clearInterval(detailInterval)');
  });

  it('periodically reloads Brief Review without flashing its loading state', () => {
    expect(source).toContain('const BRIEF_REFRESH_MS = 5000');
    expect(source).toContain('const briefInterval = window.setInterval');
    expect(source).toContain('void loadBrief(false)');
    expect(source).toContain('window.clearInterval(briefInterval)');
  });
});
