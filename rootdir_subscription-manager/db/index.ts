import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

const connectionString = process.env.DATABASE_URL;

const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

// 環境変数 DB_MAX_CONNECTIONS があれば使い、なければデフォルト設定
const MAX_CONNECTIONS = process.env.DB_MAX_CONNECTIONS ? parseInt(process.env.DB_MAX_CONNECTIONS) : (process.env.NODE_ENV === 'production' ? 10 : 1);

const client = globalForDb.conn ?? postgres(connectionString, { 
  max: MAX_CONNECTIONS,
});

if (process.env.NODE_ENV !== 'production') {
  globalForDb.conn = client;
}

export const db = drizzle(client, { schema });
