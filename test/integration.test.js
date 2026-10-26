const assert = require('node:assert/strict');
const { once } = require('node:events');
const { after, before, test } = require('node:test');
const { createApp, initializeDatabase } = require('../src/server');

const secret = 'integration-test-secret-with-more-than-thirty-two-characters';
const password = 'correct horse battery staple';
let pool;
let server;
let baseUrl;
let loadedOfficialLevelId;
let officialLevelResponse = '<level id="1786343" />';

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const database = new PGlite();
  pool = {
    async query(sql, values = []) {
      const result = await database.query(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    end: () => database.close()
  };
  await initializeDatabase(pool);
  await initializeDatabase(pool);

  const app = createApp({
    pool,
    tokenSecret: secret,
    adminEmails: 'admin@example.com',
    corsOrigins: 'http://allowed.example',
    webRoot: require('node:path').join(__dirname, '..', 'public'),
    loadOfficialLevel: async (id, params) => {
      loadedOfficialLevelId = id;
      assert.equal(params.action, 'get_level');
      return { status: 200, contentType: 'application/xml', body: officialLevelResponse };
    }
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (pool) await pool.end();
});

async function request(path, { token, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body instanceof URLSearchParams) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    options.body = options.body.toString();
  } else if (options.body && typeof options.body !== 'string') {
    headers.set('Content-Type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

async function json(response) {
  return response.json();
}

test('website, account lifecycle, file-backed catalog, legacy game loading, and access controls', async () => {
  const home = await request('/');
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /id="game-frame"/);
  assert.match(homeHtml, /src="\/game\.html"/);

  const game = await request('/game.html');
  assert.equal(game.status, 200);
  const gameHtml = await game.text();
  assert.match(gameHtml, /HW_SETTINGS/);
  assert.match(gameHtml, /siteURL: `\$\{window\.WHEELS_HAPPY_API_URL\}\/`/);
  assert.doesNotMatch(gameHtml, /siteURL:.*totaljerkface\.com/);
  for (const path of [
    '/js/dependencies.ac8072eb8a22557c1b4828699b35bec7.js',
    '/js/index.js',
    '/assets/audio/game/Victory.ogg'
  ]) {
    const asset = await request(path, { method: 'HEAD' });
    assert.equal(asset.status, 200, `${path} should be served by the website`);
  }

  const catalog = await request('/get_level.hw');
  assert.equal(catalog.status, 200);
  assert.match(catalog.headers.get('content-type'), /application\/xml/);
  const catalogXml = await catalog.text();
  assert.match(catalogXml, /<lvs>/);
  assert.match(catalogXml, /ln="The Combine 2\.1"/);

  const featured = await request('/get_level.hw', {
    method: 'POST',
    body: new URLSearchParams({ action: 'get_featured' })
  });
  assert.equal(featured.status, 200);
  assert.match(await featured.text(), /ln="The Combine 2\.1"/);

  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await json(health), { status: 'ok', database: 'connected' });

  const invalidRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'not-an-email', display_name: 'Player', password: 'too-short' }
  });
  assert.equal(invalidRegistration.status, 400);

  const registration = await request('/api/auth/register', {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: { email: 'Player@example.com', display_name: 'Player One', password }
  });
  assert.equal(registration.status, 201);
  const account = await json(registration);
  assert.equal(account.user.email, 'player@example.com');
  assert.equal(account.user.displayName, 'Player One');
  assert.ok(account.token);
  assert.equal(Object.hasOwn(account.user, 'password_hash'), false);

  const duplicate = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'player@example.com', display_name: 'Another', password }
  });
  assert.equal(duplicate.status, 409);

  const wrongPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'player@example.com', password: 'wrong password' }
  });
  assert.equal(wrongPassword.status, 401);

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'PLAYER@example.com', password }
  });
  assert.equal(login.status, 200);
  const session = await json(login);
  const me = await request('/api/auth/me', { token: session.token });
  assert.equal(me.status, 200);
  assert.equal((await json(me)).user.id, account.user.id);

  const list = await request('/api/levels?limit=30');
  assert.equal(list.status, 200);
  const browsePayload = await json(list);
  assert.equal(browsePayload.total, 139);
  assert.equal(browsePayload.levels.length, 30);
  assert.equal(browsePayload.levels[0].title, 'The Combine 2.1');
  assert.equal(browsePayload.levels[0].author, 'PLT');
  const search = await request('/api/levels?search=combine');
  assert.equal((await json(search)).levels[0].id, 1786343);
  const secondPage = await request('/api/levels?limit=30&offset=30');
  assert.notEqual((await json(secondPage)).levels[0].id, browsePayload.levels[0].id);
  const lastPage = await request('/api/levels?limit=50&offset=100');
  const lastPagePayload = await json(lastPage);
  assert.equal(lastPagePayload.levels.length, 39);
  assert.equal(lastPagePayload.total, 139);

  const legacyLevel = await request('/get_level.hw', {
    method: 'POST',
    body: new URLSearchParams({ level_id: '1786343', action: 'get_level' })
  });
  assert.equal(legacyLevel.status, 200);
  assert.match(legacyLevel.headers.get('content-type'), /application\/xml/);
  assert.equal(await legacyLevel.text(), '<level id="1786343" />');
  assert.equal(loadedOfficialLevelId, '1786343');
  officialLevelResponse = '<?xml version="1.0"?><lvs><lv id="1786343" /></lvs>';
  const metadataInsteadOfLevel = await request('/get_level.hw?level_id=1786343');
  assert.equal(metadataInsteadOfLevel.status, 502);
  assert.match(await metadataInsteadOfLevel.text(), /catalogue metadata, not playable level data/);
  officialLevelResponse = '<level id="1786343" />';

  const invalidLegacyLevel = await request('/get_level.hw?level_id=not-a-number');
  assert.equal(invalidLegacyLevel.status, 400);
  const unknownLegacyLevel = await request('/get_level.hw?level_id=999999999');
  assert.equal(unknownLegacyLevel.status, 404);

  const secondRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'second@example.com', display_name: 'Second', password }
  });
  const secondAccount = await json(secondRegistration);

  const adminRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'admin@example.com', display_name: 'Administrator', password }
  });
  const adminAccount = await json(adminRegistration);
  const adminProfile = await request('/api/auth/me', { token: adminAccount.token });
  assert.equal((await json(adminProfile)).isAdmin, true);

  const logout = await request('/api/auth/logout', { method: 'POST', token: session.token });
  assert.equal(logout.status, 204);
  const loggedOut = await request('/api/auth/me', { token: session.token });
  assert.equal(loggedOut.status, 401);
  const remainingAccount = await request('/api/auth/me', { token: secondAccount.token });
  assert.equal(remainingAccount.status, 200);

  const disallowedOrigin = await request('/api/health', {
    headers: { Origin: 'https://not-allowed.example' }
  });
  assert.equal(disallowedOrigin.status, 403);
  const allowedOrigin = await request('/api/health', {
    headers: { Origin: 'http://allowed.example' }
  });
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'http://allowed.example');
});
