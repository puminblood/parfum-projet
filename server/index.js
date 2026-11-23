import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startLocalDatabase } from './database.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
let pool;
let localDatabase;
const port = Number(process.env.PORT || 4173);

const stages = new Set(['selection', 'lab_availability', 'sample_weighing', 'reweigh', 'sample_evaluation', 'commercial_review', 'client_sample']);
const participantRoles = new Set(['commercial', 'assistant_commercial', 'parfumeur', 'a_classer']);
const transitions = {
  selection: ['lab_availability'],
  lab_availability: ['sample_weighing', 'reweigh'],
  sample_weighing: ['sample_evaluation'],
  reweigh: ['sample_evaluation'],
  sample_evaluation: ['commercial_review'],
  commercial_review: ['client_sample']
};
const statuses = new Set(['in_progress', 'finished']);
const decisions = new Set(['pending', 'won', 'lost']);

const projectSelect = `
  SELECT p.*,
    COALESCE((SELECT json_agg(json_build_object('id', x.id, 'name', x.name, 'organization', x.organization, 'role', x.role) ORDER BY x.role, x.name)
      FROM project_participants pp JOIN participants x ON x.id = pp.participant_id WHERE pp.project_id = p.id), '[]'::json) AS participants,
    COALESCE((SELECT json_agg(json_build_object('id', r.id, 'label', r.label, 'details', r.details) ORDER BY r.label)
      FROM project_references pr JOIN product_references r ON r.id = pr.reference_id WHERE pr.project_id = p.id), '[]'::json) AS "references",
    (SELECT count(*)::int FROM project_notes n WHERE n.project_id = p.id) AS note_count,
    (SELECT json_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at)
      FROM project_notes n WHERE n.project_id = p.id AND n.show_on_dashboard
      ORDER BY n.created_at DESC LIMIT 1) AS dashboard_note
  FROM projects p`;

function send(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function cleanString(value, max = 5000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function resolveIds(client, table, values) {
  const input = Array.isArray(values) ? values : [];
  const unique = new Map();
  for (const value of input) {
    if (table === 'participants') {
      const name = cleanString(typeof value === 'string' ? value : value?.name, 240);
      const role = participantRoles.has(value?.role) ? value.role : 'parfumeur';
      if (name) unique.set(`${role}:${name.toLocaleLowerCase('fr-FR')}`, { name, role });
    } else {
      const label = cleanString(typeof value === 'string' ? value : value?.label, 240);
      if (label) unique.set(label.toLocaleLowerCase('fr-FR'), { label });
    }
  }
  const ids = [];
  for (const value of unique.values()) {
    if (table === 'participants') {
      if (value.role !== 'a_classer') {
        const existing = await client.query('SELECT id FROM participants WHERE lower(name)=lower($1) AND role=$2', [value.name, value.role]);
        if (existing.rowCount) { ids.push(existing.rows[0].id); continue; }
        const classified = await client.query("UPDATE participants SET role=$1 WHERE lower(name)=lower($2) AND role='a_classer' RETURNING id", [value.role, value.name]);
        if (classified.rowCount) { ids.push(classified.rows[0].id); continue; }
      }
      const result = await client.query(
        `INSERT INTO participants(name, role) VALUES ($1,$2)
         ON CONFLICT (lower(name), role) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`, [value.name, value.role]);
      ids.push(result.rows[0].id);
    } else {
      const result = await client.query(
        `INSERT INTO product_references(label) VALUES ($1)
         ON CONFLICT (lower(label)) DO UPDATE SET label = EXCLUDED.label
         RETURNING id`, [value.label]);
      ids.push(result.rows[0].id);
    }
  }
  return ids;
}

async function writeProject(req, res, id = null) {
  const data = await bodyOf(req);
  const title = cleanString(data.title, 240);
  if (!title) return send(res, 400, { error: 'Le nom du projet est obligatoire.' });
  const stage = stages.has(data.stage) ? data.stage : null;
  const status = statuses.has(data.status) ? data.status : 'in_progress';
  const decision = decisions.has(data.decision) ? data.decision : 'pending';
  const deadline = data.deadline || null;
  const rmcAmount = data.rmc_amount === '' || data.rmc_amount == null ? null : Number(data.rmc_amount);
  if (rmcAmount !== null && (!Number.isFinite(rmcAmount) || rmcAmount < 0 || rmcAmount > 9999999999.99)) {
    return send(res, 400, { error: 'Le RMC doit être un montant positif en euros.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let projectId = id;
    if (id) {
      const result = await client.query(
        `UPDATE projects SET title=$1, client=$2, brief=$3, stage=COALESCE($4,stage), status=$5, decision=$6, deadline=$7, rmc_amount=$8, updated_at=now()
         WHERE id=$9 RETURNING id`,
        [title, cleanString(data.client, 240), cleanString(data.brief), stage, status, decision, deadline, rmcAmount, id]);
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return send(res, 404, { error: 'Projet introuvable.' });
      }
    } else {
      const result = await client.query(
        `INSERT INTO projects(title, client, brief, stage, status, decision, deadline, rmc_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [title, cleanString(data.client, 240), cleanString(data.brief), stage || 'selection', status, decision, deadline, rmcAmount]);
      projectId = result.rows[0].id;
    }
    const people = await resolveIds(client, 'participants', data.participants);
    const refs = await resolveIds(client, 'product_references', data.references);
    await client.query('DELETE FROM project_participants WHERE project_id=$1', [projectId]);
    await client.query('DELETE FROM project_references WHERE project_id=$1', [projectId]);
    for (const personId of people) await client.query('INSERT INTO project_participants(project_id, participant_id) VALUES ($1,$2)', [projectId, personId]);
    for (const refId of refs) await client.query('INSERT INTO project_references(project_id, reference_id) VALUES ($1,$2)', [projectId, refId]);
    await client.query('COMMIT');
    const result = await pool.query(`${projectSelect} WHERE p.id=$1`, [projectId]);
    send(res, id ? 200 : 201, result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true, app: 'parfum-projets' });
    if (req.method === 'POST' && pathname === '/api/shutdown') {
      const expectedToken = process.env.PARFUM_SHUTDOWN_TOKEN || '';
      const suppliedToken = String(req.headers['x-parfum-shutdown'] || '');
      if (!expectedToken || suppliedToken !== expectedToken) return send(res, 403, { error: 'Action non autorisee.' });
      send(res, 202, { ok: true });
      setTimeout(() => { void shutdown(0); }, 200);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/projects') {
      const result = await pool.query(`${projectSelect} ORDER BY
        CASE WHEN p.deadline < CURRENT_DATE AND p.status='in_progress' THEN 0
             WHEN p.deadline <= CURRENT_DATE + 7 AND p.status='in_progress' THEN 1 ELSE 2 END,
        p.deadline NULLS LAST, p.updated_at DESC`);
      return send(res, 200, result.rows);
    }
    if (req.method === 'POST' && pathname === '/api/projects') return writeProject(req, res);
    const advanceMatch = pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/advance$/i);
    if (advanceMatch && req.method === 'POST') {
      const projectId = advanceMatch[1]; const data = await bodyOf(req);
      if (!stages.has(data.stage)) return send(res, 400, { error: 'Étape non reconnue.' });
      const client = await pool.connect();
      try {
        const result = await client.query('SELECT stage FROM projects WHERE id=$1', [projectId]);
        if (!result.rowCount) return send(res, 404, { error: 'Projet introuvable.' });
        if (!(transitions[result.rows[0].stage] || []).includes(data.stage)) return send(res, 409, { error: 'Cette étape ne suit pas l’étape actuelle.' });
        await client.query('UPDATE projects SET stage=$1, updated_at=now() WHERE id=$2', [data.stage, projectId]);
        const project = await pool.query(`${projectSelect} WHERE p.id=$1`, [projectId]);
        return send(res, 200, project.rows[0]);
      } finally { client.release(); }
    }
    const restartMatch = pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/restart$/i);
    if (restartMatch && req.method === 'POST') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const exists = await client.query('SELECT id FROM projects WHERE id=$1', [restartMatch[1]]);
        if (!exists.rowCount) { await client.query('ROLLBACK'); return send(res, 404, { error: 'Projet introuvable.' }); }
        await client.query("UPDATE projects SET stage='selection', updated_at=now() WHERE id=$1", [restartMatch[1]]);
        const note = cleanString((await bodyOf(req)).note, 10000);
        if (note) await client.query('INSERT INTO project_notes(project_id, body, show_on_dashboard) VALUES ($1,$2,false)', [restartMatch[1], note]);
        await client.query('COMMIT');
        const result = await pool.query(`${projectSelect} WHERE p.id=$1`, [restartMatch[1]]);
        return send(res, 200, result.rows[0]);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const projectReferencesMatch = pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/references$/i);
    if (projectReferencesMatch && req.method === 'PUT') {
      const projectId = projectReferencesMatch[1]; const data = await bodyOf(req);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const exists = await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
        if (!exists.rowCount) { await client.query('ROLLBACK'); return send(res, 404, { error: 'Projet introuvable.' }); }
        const refs = await resolveIds(client, 'product_references', data.references);
        await client.query('DELETE FROM project_references WHERE project_id=$1', [projectId]);
        for (const referenceId of refs) await client.query('INSERT INTO project_references(project_id, reference_id) VALUES ($1,$2)', [projectId, referenceId]);
        await client.query('UPDATE projects SET updated_at=now() WHERE id=$1', [projectId]);
        await client.query('COMMIT');
        const project = await pool.query(`${projectSelect} WHERE p.id=$1`, [projectId]);
        return send(res, 200, project.rows[0]);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const projectMatch = pathname.match(/^\/api\/projects\/([0-9a-f-]+)$/i);
    if (projectMatch && req.method === 'PUT') return writeProject(req, res, projectMatch[1]);
    if (projectMatch && req.method === 'DELETE') {
      const result = await pool.query('DELETE FROM projects WHERE id=$1 RETURNING id', [projectMatch[1]]);
      return send(res, result.rowCount ? 200 : 404, result.rowCount ? { ok: true } : { error: 'Projet introuvable.' });
    }
    const notesMatch = pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/notes$/i);
    if (notesMatch && req.method === 'GET') {
      const result = await pool.query('SELECT id, body, show_on_dashboard, created_at FROM project_notes WHERE project_id=$1 ORDER BY created_at DESC', [notesMatch[1]]);
      return send(res, 200, result.rows);
    }
    if (notesMatch && req.method === 'POST') {
      const data = await bodyOf(req);
      const note = cleanString(data.body, 10000);
      if (!note) return send(res, 400, { error: 'La note ne peut pas être vide.' });
      const result = await pool.query(
        `INSERT INTO project_notes(project_id, body, show_on_dashboard) VALUES ($1,$2,$3)
         RETURNING id, body, show_on_dashboard, created_at`,
        [notesMatch[1], note, Boolean(data.show_on_dashboard)]);
      await pool.query('UPDATE projects SET updated_at=now() WHERE id=$1', [notesMatch[1]]);
      return send(res, 201, result.rows[0]);
    }
    if (req.method === 'GET' && pathname === '/api/participants') {
      const result = await pool.query('SELECT x.id, x.name, x.organization, x.role, (SELECT count(*)::int FROM project_participants pp WHERE pp.participant_id=x.id) AS project_count FROM participants x ORDER BY x.role, lower(x.name)');
      return send(res, 200, result.rows);
    }
    if (req.method === 'GET' && pathname === '/api/references') {
      const result = await pool.query('SELECT x.id, x.label, x.details, (SELECT count(*)::int FROM project_references pr WHERE pr.reference_id=x.id) AS project_count FROM product_references x ORDER BY lower(x.label)');
      return send(res, 200, result.rows);
    }
    const personDelete = pathname.match(/^\/api\/participants\/([0-9a-f-]+)$/i);
    if (personDelete && req.method === 'DELETE') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const detached = await client.query('DELETE FROM project_participants WHERE participant_id=$1', [personDelete[1]]);
        const deleted = await client.query('DELETE FROM participants WHERE id=$1 RETURNING id', [personDelete[1]]);
        await client.query('COMMIT');
        return send(res, deleted.rowCount ? 200 : 404, deleted.rowCount ? { ok: true, project_count: detached.rowCount } : { error: 'Intervenant introuvable.' });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const referenceDelete = pathname.match(/^\/api\/references\/([0-9a-f-]+)$/i);
    if (referenceDelete && req.method === 'DELETE') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const detached = await client.query('DELETE FROM project_references WHERE reference_id=$1', [referenceDelete[1]]);
        const deleted = await client.query('DELETE FROM product_references WHERE id=$1 RETURNING id', [referenceDelete[1]]);
        await client.query('COMMIT');
        return send(res, deleted.rowCount ? 200 : 404, deleted.rowCount ? { ok: true, project_count: detached.rowCount } : { error: 'Référence introuvable.' });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    return send(res, 404, { error: 'Route inconnue.' });
  }

  const filePath = pathname === '/' ? path.join(root, 'index.html') : path.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(root + path.sep) && filePath !== path.join(root, 'index.html')) return send(res, 403, 'Interdit', 'text/plain; charset=utf-8');
  try {
    await stat(filePath);
    const content = await readFile(filePath);
    const type = filePath.endsWith('.css') ? 'text/css; charset=utf-8' : filePath.endsWith('.js') ? 'text/javascript; charset=utf-8' : filePath.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8';
    return send(res, 200, content, type);
  } catch {
    return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'Une erreur est survenue.', detail: error.message });
  });
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error('Le port local de l’application est déjà utilisé. Fermez une autre fenêtre de lancement puis réessayez.');
  else console.error(error.message);
  shutdown(1);
});

function openBrowser() {
  if (process.env.PARFUM_OPEN_BROWSER === '0') return;
  const address = `http://127.0.0.1:${port}`;
  const command = process.platform === 'win32' ? 'cmd.exe' : 'open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', address] : [address];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

let shutdownPromise;
async function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  process.exitCode = exitCode;
  shutdownPromise = (async () => {
    if (server.listening) await new Promise(resolve => server.close(() => resolve()));
    if (pool) await pool.end().catch(() => {});
    if (localDatabase) await localDatabase.stop().catch(() => {});
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    process.off('SIGHUP', handleSignal);
  })();
  return shutdownPromise;
}

async function start() {
  try {
    localDatabase = await startLocalDatabase();
    pool = localDatabase.pool;
    server.listen(port, '127.0.0.1', () => {
      console.log(`Parfum projets est prêt : http://127.0.0.1:${port}`);
      openBrowser();
    });
  } catch (error) {
    console.error('Le démarrage de Parfum projets a échoué.');
    console.error(error.message);
    console.error('Fermez cette fenêtre, vérifiez la connexion Internet au premier lancement, puis réessayez.');
    await shutdown(1);
  }
}

function handleSignal() { void shutdown(0); }
process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
process.on('SIGHUP', handleSignal);
start();
