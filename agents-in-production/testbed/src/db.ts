import pg from 'pg';

export type Db = pg.Pool;

export const connect = (url = process.env.DATABASE_URL ?? 'postgres://lens:lens@localhost:54329/lens'): Db =>
  new pg.Pool({ connectionString: url, max: 5 });
