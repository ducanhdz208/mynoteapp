const crypto = require('crypto');
const express = require('express');
const { sql } = require('@vercel/postgres');
const path = require('path');

const app = express();
const SESSION_COOKIE = 'notes_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const loginAttempts = new Map();

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const getPassword = () => process.env.APP_PASSWORD || 'admin';

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const signSession = (timestamp) => crypto
  .createHmac('sha256', getPassword())
  .update(timestamp)
  .digest('base64url');

const createSessionToken = () => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return `${timestamp}.${signSession(timestamp)}`;
};

const parseCookies = (cookieHeader = '') => Object.fromEntries(
  cookieHeader
    .split(';')
    .map((part) => part.trim().split('='))
    .filter(([key, value]) => key && value)
    .map(([key, value]) => [key, decodeURIComponent(value)])
);

const isValidSession = (token = '') => {
  const [timestamp, signature] = token.split('.');
  if (!timestamp || !signature || !safeEqual(signature, signSession(timestamp))) {
    return false;
  }

  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  return Number.isFinite(age) && age >= 0 && age <= SESSION_MAX_AGE;
};

const sessionCookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: req.secure || req.get('x-forwarded-proto') === 'https',
  maxAge: SESSION_MAX_AGE * 1000,
  path: '/'
});

const requireAuth = (req, res, next) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (isValidSession(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Authentication required' });
};

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const normalizeTags = (tags) => {
  const values = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(values.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20);
};

const normalizeSortOrder = (value) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : 0;
};

const normalizeNote = (body = {}) => ({
  title: String(body.title || 'Untitled Note').slice(0, 300),
  content: String(body.content || ''),
  contentFormat: body.content_format === 'html' ? 'html' : 'markdown',
  folder: String(body.folder || 'Notes').trim().slice(0, 100) || 'Notes',
  tags: normalizeTags(body.tags),
  pinned: Boolean(body.pinned),
  favorite: Boolean(body.favorite),
  sortOrder: normalizeSortOrder(body.sort_order)
});

async function initDB() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS notes (
        id SERIAL PRIMARY KEY,
        title TEXT,
        content TEXT
      )
    `;
    await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS folder TEXT DEFAULT 'Notes'`;
    await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`;
    await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS favorite BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS content_format TEXT DEFAULT 'markdown'`;
    await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS sort_order BIGINT DEFAULT 0`;
    await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;
    await sql`
      CREATE TABLE IF NOT EXISTS note_versions (
        id SERIAL PRIMARY KEY,
        note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        title TEXT,
        content TEXT,
        folder TEXT,
        tags TEXT[],
        pinned BOOLEAN,
        favorite BOOLEAN,
        content_format TEXT DEFAULT 'markdown',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      ALTER TABLE note_versions
      ADD COLUMN IF NOT EXISTS content_format TEXT DEFAULT 'markdown'
    `;
  } catch (error) {
    console.error('DB initialization failed:', error);
  }
}

const databaseReady = initDB();

app.use(['/api/notes', '/api/import'], asyncRoute(async (req, res, next) => {
  await databaseReady;
  next();
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };

  if (now > attempt.resetAt) {
    attempt.count = 0;
    attempt.resetAt = now + 15 * 60 * 1000;
  }
  if (attempt.count >= 10) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  if (!safeEqual(req.body.password || '', getPassword())) {
    attempt.count += 1;
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: 'Incorrect password' });
  }

  loginAttempts.delete(ip);
  res.cookie(SESSION_COOKIE, createSessionToken(), sessionCookieOptions(req));
  return res.json({ authenticated: true });
}));

app.get('/api/session', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  res.json({ authenticated: isValidSession(token) });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(req), maxAge: 0 });
  res.json({ authenticated: false });
});

app.get('/api/notes', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await sql`
    SELECT
      id, title, content, content_format, folder, tags, pinned, favorite,
      sort_order, updated_at
    FROM notes
    ORDER BY pinned DESC, sort_order ASC, updated_at DESC, id DESC
  `;
  res.json(rows);
}));

app.post('/api/notes', requireAuth, asyncRoute(async (req, res) => {
  const note = normalizeNote(req.body);
  const { rows } = await sql`
    INSERT INTO notes (
      title, content, content_format, folder, tags, pinned, favorite,
      sort_order, updated_at
    )
    VALUES (
      ${note.title},
      ${note.content},
      ${note.contentFormat},
      ${note.folder},
      ${note.tags},
      ${note.pinned},
      ${note.favorite},
      ${note.sortOrder},
      NOW()
    )
    RETURNING
      id, title, content, content_format, folder, tags, pinned, favorite,
      sort_order, updated_at
  `;
  res.status(201).json(rows[0]);
}));

app.post('/api/notes/reorder', requireAuth, asyncRoute(async (req, res) => {
  const orderedIds = [...new Set(
    (Array.isArray(req.body.orderedIds) ? req.body.orderedIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
  )].slice(0, 1000);

  if (!orderedIds.length) {
    return res.status(400).json({ error: 'No note order supplied' });
  }

  const { rowCount } = await sql`
    UPDATE notes
    SET sort_order = positions.sort_order
    FROM unnest(${orderedIds}::bigint[]) WITH ORDINALITY
      AS positions(id, sort_order)
    WHERE notes.id = positions.id
  `;
  return res.json({ reordered: rowCount });
}));

app.put('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const note = normalizeNote(req.body);
  const { rows: existingRows } = await sql`
    SELECT
      id, title, content, content_format, folder, tags, pinned, favorite,
      sort_order
    FROM notes
    WHERE id = ${req.params.id}
  `;
  const existing = existingRows[0];
  if (!existing) {
    return res.status(404).json({ error: 'Note not found' });
  }

  const changed = existing.title !== note.title
    || existing.content !== note.content
    || existing.content_format !== note.contentFormat
    || existing.folder !== note.folder
    || JSON.stringify(existing.tags || []) !== JSON.stringify(note.tags)
    || existing.pinned !== note.pinned
    || existing.favorite !== note.favorite;

  if (changed) {
    await sql`
      INSERT INTO note_versions (
        note_id, title, content, content_format, folder, tags, pinned, favorite
      )
      VALUES (
        ${existing.id},
        ${existing.title},
        ${existing.content},
        ${existing.content_format},
        ${existing.folder},
        ${existing.tags || []},
        ${existing.pinned},
        ${existing.favorite}
      )
    `;
  }

  const { rows } = await sql`
    UPDATE notes
    SET
      title = ${note.title},
      content = ${note.content},
      content_format = ${note.contentFormat},
      folder = ${note.folder},
      tags = ${note.tags},
      pinned = ${note.pinned},
      favorite = ${note.favorite},
      sort_order = ${note.sortOrder},
      updated_at = NOW()
    WHERE id = ${req.params.id}
    RETURNING
      id, title, content, content_format, folder, tags, pinned, favorite,
      sort_order, updated_at
  `;
  return res.json(rows[0]);
}));

app.delete('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const { rowCount } = await sql`DELETE FROM notes WHERE id = ${req.params.id}`;
  if (!rowCount) {
    return res.status(404).json({ error: 'Note not found' });
  }
  return res.json({ deleted: true });
}));

app.get('/api/notes/:id/history', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await sql`
    SELECT
      id, note_id, title, content, content_format, folder, tags, pinned,
      favorite, created_at
    FROM note_versions
    WHERE note_id = ${req.params.id}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  res.json(rows);
}));

app.post('/api/notes/:id/history/:versionId/restore', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await sql`
    SELECT title, content, content_format, folder, tags, pinned, favorite
    FROM note_versions
    WHERE id = ${req.params.versionId} AND note_id = ${req.params.id}
  `;
  if (!rows[0]) {
    return res.status(404).json({ error: 'Version not found' });
  }

  const current = await sql`
    SELECT title, content, content_format, folder, tags, pinned, favorite
    FROM notes
    WHERE id = ${req.params.id}
  `;
  if (!current.rows[0]) {
    return res.status(404).json({ error: 'Note not found' });
  }

  const old = current.rows[0];
  await sql`
    INSERT INTO note_versions (
      note_id, title, content, content_format, folder, tags, pinned, favorite
    )
    VALUES (
      ${req.params.id},
      ${old.title},
      ${old.content},
      ${old.content_format},
      ${old.folder},
      ${old.tags || []},
      ${old.pinned},
      ${old.favorite}
    )
  `;

  const version = rows[0];
  const restored = await sql`
    UPDATE notes
    SET
      title = ${version.title},
      content = ${version.content},
      content_format = ${version.content_format},
      folder = ${version.folder},
      tags = ${version.tags || []},
      pinned = ${version.pinned},
      favorite = ${version.favorite},
      updated_at = NOW()
    WHERE id = ${req.params.id}
    RETURNING
      id, title, content, content_format, folder, tags, pinned, favorite,
      sort_order, updated_at
  `;
  return res.json(restored.rows[0]);
}));

app.post('/api/import', requireAuth, asyncRoute(async (req, res) => {
  const importedNotes = Array.isArray(req.body.notes) ? req.body.notes.slice(0, 500) : [];
  if (!importedNotes.length) {
    return res.status(400).json({ error: 'No notes supplied' });
  }

  const created = [];
  for (const [index, input] of importedNotes.entries()) {
    const note = normalizeNote(input);
    const { rows } = await sql`
      INSERT INTO notes (
        title, content, content_format, folder, tags, pinned, favorite,
        sort_order, updated_at
      )
      VALUES (
        ${note.title},
        ${note.content},
        ${note.contentFormat},
        ${note.folder},
        ${note.tags},
        ${note.pinned},
        ${note.favorite},
        ${normalizeSortOrder(input.sort_order ?? index)},
        NOW()
      )
      RETURNING
        id, title, content, content_format, folder, tags, pinned, favorite,
        sort_order, updated_at
    `;
    created.push(rows[0]);
  }
  return res.status(201).json({ imported: created.length, notes: created });
}));

app.use('/api', (error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Unexpected server error' });
});

if (require.main === module) {
  app.listen(3000, '0.0.0.0', () => console.log('✅ Local server running on port 3000'));
}

module.exports = app;
