# My Notes

A private rich-text note app built with Express, Vue, and Vercel Postgres.

## Features

- Full-text search across titles, content, folders, and tags
- Folders, tags, pinned notes, favorites, and saved drag-and-drop ordering
- Rich-text editing with font, size, heading, emphasis, list, and link controls
- Automatic rich formatting when Markdown is pasted
- One-time conversion of existing Markdown notes when they are opened
- Autosave status and version history with restore
- Markdown export plus JSON backup and import
- Keyboard shortcuts
- Offline app shell, local note cache, and queued synchronization
- Signed HTTP-only authentication sessions
- Responsive desktop and mobile layouts

## Keyboard shortcuts

- `Cmd/Ctrl + N` — create a note
- `Cmd/Ctrl + K` — focus search
- `Cmd/Ctrl + S` — save immediately
- `Escape` — close history or return to the note list

## Run locally

Set these environment variables:

- `POSTGRES_URL` — Vercel Postgres connection string
- `APP_PASSWORD` — master password (defaults to `admin` for local development)

Then run:

```sh
npm start
```

The app is available at `http://localhost:3000`.
