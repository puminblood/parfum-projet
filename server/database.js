import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const { Pool } = pg;
const port = 54329;

function defaultDataDirectory() {
  if (process.env.PARFUM_DATA_DIR) return path.resolve(process.env.PARFUM_DATA_DIR);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ParfumProjets');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ParfumProjets');
  return path.join(os.homedir(), '.local', 'share', 'ParfumProjets');
}

async function getPassword(dataDirectory) {
  const settingsFile = path.join(dataDirectory, 'database-settings.json');
  let raw;
  try {
    raw = await readFile(settingsFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (raw) {
    const saved = JSON.parse(raw);
    if (typeof saved.password === 'string' && saved.password.length >= 32) return saved.password;
    throw new Error('Les paramètres de la base locale sont incomplets. Les données existantes ont été conservées.');
  }
  const password = randomBytes(32).toString('hex');
  await writeFile(settingsFile, JSON.stringify({ password }), { encoding: 'utf8', mode: 0o600 });
  return password;
}

export async function startLocalDatabase() {
  const dataDirectory = defaultDataDirectory();
  await mkdir(dataDirectory, { recursive: true });
  const password = await getPassword(dataDirectory);
  const databaseDirectory = path.join(dataDirectory, 'postgres-data');
  const database = new EmbeddedPostgres({
    databaseDir: databaseDirectory,
    user: 'postgres',
    password,
    port,
    persistent: true,
    authMethod: 'scram-sha-256',
    autoRehydrateSymlinks: true,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1']
  });

  try {
    await access(path.join(databaseDirectory, 'PG_VERSION'));
  } catch {
    await database.initialise();
  }
  await database.start();
  try {
    const admin = database.getPgClient();
    await admin.connect();
    try {
      const result = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['parfum_projets']);
      if (!result.rowCount) await database.createDatabase('parfum_projets');
    } finally {
      await admin.end();
    }
  } catch (error) {
    await database.stop().catch(() => {});
    throw error;
  }

  const connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/parfum_projets`;
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
  try {
    await pool.query(await readFile(schemaPath, 'utf8'));
  } catch (error) {
    await pool.end();
    await database.stop().catch(() => {});
    throw error;
  }
  return { pool, stop: () => database.stop() };
}
