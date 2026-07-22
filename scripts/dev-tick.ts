// Ручной тик runIteration — для критерия «сделано» фазы 1.4
// (plans/): два прогона подряд → одна event.trigger
// + одна audit.repeat. idempotencyKey детерминированный (manual-tick:YYYY-MM-DD).

import { runIteration } from '../src/core/loop.js';
import { triggerDevTick } from '../src/core/triggers.js';
import { disposePrisma, getPrisma } from '../src/db/client.js';

async function main(): Promise<void> {
  const db = getPrisma();
  try {
    const result = await runIteration(triggerDevTick(), { db });
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
