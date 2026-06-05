import { disposePrisma, disposeVecClient, getPrisma, getVecClient } from '../src/db/client.js';
import { assertSchemaInvariants, assertVecInvariants } from '../src/db/invariants-check.js';
import { loadEmbeddingsConfig } from '../src/embeddings/config.js';

async function main(): Promise<void> {
  const db = getPrisma();
  try {
    await assertSchemaInvariants(db);
    const embeddings = await loadEmbeddingsConfig();
    const vec = getVecClient();
    assertVecInvariants(vec, { vecTable: embeddings.vecTable });
    console.log('✓ schema invariants OK');
    console.log(`✓ sqlite-vec OK (table=${embeddings.vecTable}, dim=${embeddings.dim})`);
  } finally {
    disposeVecClient();
    await disposePrisma();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`✗ ${message}`);
  process.exit(1);
});
