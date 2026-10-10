import { readFile } from 'node:fs/promises';
import { connect } from '@lens/testbed/db.ts';
import { startPaymentsServer } from '@lens/testbed/payments/server.ts';

const SCHEMAS = ['../../testbed/src/schema.sql', '../src/schema.sql'];
const TABLES = ['steps', 'runs', 'conversations', 'charges', 'scripted_calls'];

// Recreates the tables and starts the payments service once for the whole run.
export default async function setup() {
  const db = connect();
  await db.query(`drop table if exists ${TABLES.join(', ')} cascade`);
  for (const schema of SCHEMAS) {
    await db.query(await readFile(new URL(schema, import.meta.url), 'utf8'));
  }
  const payments = await startPaymentsServer(db, Number(process.env.PAYMENTS_PORT ?? 4100));

  return async () => {
    payments.close();
    await db.end();
  };
}
