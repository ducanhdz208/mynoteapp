const express = require('express');
const { sql } = require('@vercel/postgres');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create the Postgres table automatically if it doesn't exist
async function initDB() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS notes (
        id SERIAL PRIMARY KEY, 
        title TEXT, 
        content TEXT
      );
    `;
  } catch (error) {
    console.error("Database initialization failed:", error);
  }
}
initDB();

// GET: Fetch all notes
app.get('/api/notes', async (req, res) => {
  const { rows } = await sql`SELECT * FROM notes ORDER BY id DESC`;
  res.json(rows);
});

// POST: Create a new note
app.post('/api/notes', async (req, res) => {
  const { title, content } = req.body;
  // In Postgres, we use RETURNING * to immediately get the newly created note's ID
  const { rows } = await sql`INSERT INTO notes (title, content) VALUES (${title}, ${content}) RETURNING *`;
  res.json(rows[0]);
});

// PUT: Update a note
app.put('/api/notes/:id', async (req, res) => {
  const { title, content } = req.body;
  const { id } = req.params;
  await sql`UPDATE notes SET title = ${title}, content = ${content} WHERE id = ${id}`;
  res.json({ updated: true });
});

// DELETE: Delete a note
app.delete('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  await sql`DELETE FROM notes WHERE id = ${id}`;
  res.json({ deleted: true });
});

// If running locally, listen on port 3000. If on Vercel, export the app.
if (require.main === module) {
  app.listen(3000, '0.0.0.0', () => {
    console.log('✅ Local server running!');
  });
}

module.exports = app;