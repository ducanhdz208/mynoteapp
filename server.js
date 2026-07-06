const express = require('express');
const { sql } = require('@vercel/postgres');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- SECURITY CHECKPOINT ---
const requireAuth = (req, res, next) => {
  // Grab the password sent by the frontend
  const providedPass = req.headers['x-app-password'];
  // Grab the real password from Vercel (or default to 'admin' if testing locally)
  const actualPass = process.env.APP_PASSWORD || 'admin';

  if (providedPass === actualPass) {
    next(); // Password matches, let them in!
  } else {
    res.status(401).json({ error: 'Unauthorized: Wrong password' }); // Kick them out
  }
};

async function initDB() {
  try {
    await sql`CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, title TEXT, content TEXT);`;
  } catch (error) { console.error("DB Init failed:", error); }
}
initDB();

// Notice we added `requireAuth` to all of these routes!
// GET: Fetch all notes
app.get('/api/notes', requireAuth, async (req, res) => {
  const { rows } = await sql`SELECT * FROM notes ORDER BY id DESC`;
  res.json(rows);
});

// POST: Create a new note
app.post('/api/notes', requireAuth, async (req, res) => {
  const { title, content } = req.body;
  const { rows } = await sql`INSERT INTO notes (title, content) VALUES (${title}, ${content}) RETURNING *`;
  res.json(rows[0]);
});

// PUT: Update a note
app.put('/api/notes/:id', requireAuth, async (req, res) => {
  const { title, content } = req.body;
  const { id } = req.params;
  await sql`UPDATE notes SET title = ${title}, content = ${content} WHERE id = ${id}`;
  res.json({ updated: true });
});

// DELETE: Delete a note
app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  await sql`DELETE FROM notes WHERE id = ${id}`;
  res.json({ deleted: true });
});

if (require.main === module) {
  app.listen(3000, '0.0.0.0', () => console.log('✅ Local server running!'));
}
module.exports = app;