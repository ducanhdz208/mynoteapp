const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const recordedQueries = [];

const fakeSql = async (strings, ...values) => {
  const query = strings.join('$value');
  recordedQueries.push({ query, values });

  if (query.includes('UPDATE notes') && query.includes('WITH ORDINALITY')) {
    return { rows: [], rowCount: values[0].length };
  }

  if (query.includes('SELECT') && query.includes('ORDER BY pinned DESC')) {
    return {
      rows: [{
        id: 9,
        title: 'Rich note',
        content: '<p><strong>Hello</strong></p>',
        content_format: 'html',
        folder: 'Notes',
        tags: [],
        pinned: false,
        favorite: false,
        sort_order: 2,
        updated_at: '2026-07-29T00:00:00.000Z'
      }],
      rowCount: 1
    };
  }

  return { rows: [], rowCount: 0 };
};

const postgresPath = require.resolve('@vercel/postgres');
require.cache[postgresPath] = {
  id: postgresPath,
  filename: postgresPath,
  loaded: true,
  exports: { sql: fakeSql }
};

const app = require('../server');
let server;
let baseUrl;
let sessionCookie;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin' })
  });
  assert.equal(login.status, 200);
  sessionCookie = login.headers.get('set-cookie');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('database initialization includes rich-text and manual-order columns', () => {
  const initializationSql = recordedQueries.map(({ query }) => query).join('\n');
  assert.match(initializationSql, /content_format/);
  assert.match(initializationSql, /sort_order/);
});

test('notes return their content format and saved order', async () => {
  const response = await fetch(`${baseUrl}/api/notes`, {
    headers: { cookie: sessionCookie }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{
    id: 9,
    title: 'Rich note',
    content: '<p><strong>Hello</strong></p>',
    content_format: 'html',
    folder: 'Notes',
    tags: [],
    pinned: false,
    favorite: false,
    sort_order: 2,
    updated_at: '2026-07-29T00:00:00.000Z'
  }]);
});

test('reordering validates, deduplicates, and persists note ids', async () => {
  const unauthorized = await fetch(`${baseUrl}/api/notes/reorder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderedIds: [9, 4] })
  });
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/api/notes/reorder`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ orderedIds: [9, '4', 9, -1, 'invalid'] })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reordered: 2 });

  const reorderQuery = recordedQueries.find(
    ({ query }) => query.includes('WITH ORDINALITY')
  );
  assert.deepEqual(reorderQuery.values[0], [9, 4]);
});
