const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');
const { initializeDatabase } = require('./database');
const { parseLevelCatalog } = require('./level-catalog');

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_WEB_ROOT = path.join(__dirname, '..', 'public');
const LEVEL_CATALOG_PATH = path.join(DEFAULT_WEB_ROOT, 'get_level.hw');

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  }).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createToken(user, secret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: String(user.id),
    email: user.email,
    displayName: user.display_name,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token, secret) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) return null;

  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      typeof claims.sub !== 'string'
      || !Number.isSafeInteger(Number(claims.sub))
      || typeof claims.exp !== 'number'
      || claims.exp <= Date.now() / 1000
    ) return null;
    return claims;
  } catch {
    return null;
  }
}

function cleanUser(row) {
  return {
    id: Number(row.id),
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at
  };
}

function createApp({
  pool,
  tokenSecret = process.env.TOKEN_SECRET || '',
  adminEmails = process.env.ADMIN_EMAILS || '',
  corsOrigins = process.env.CORS_ORIGINS || 'null,http://localhost:8080,http://127.0.0.1:8080',
  webRoot = DEFAULT_WEB_ROOT,
  catalogPath = LEVEL_CATALOG_PATH,
  loadOfficialLevel = loadLevelFromOfficialService
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('A PostgreSQL-compatible pool is required.');
  }
  if (tokenSecret.length < 32) {
    throw new Error('TOKEN_SECRET must contain at least 32 characters.');
  }

  const allowedOrigins = new Set(corsOrigins.split(',').map((origin) => origin.trim()).filter(Boolean));
  const administrators = new Set(adminEmails.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
  const levelCatalogXml = fs.readFileSync(catalogPath, 'utf8');
  const levelsFromFile = parseLevelCatalog(levelCatalogXml);
  if (levelsFromFile.length === 0) throw new Error('get_level.hw does not contain any level catalogue entries.');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", 'https:', 'data:', 'blob:'],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https:'],
        mediaSrc: ["'self'", 'blob:', 'https:'],
        frameAncestors: ["'self'"]
      }
    }
  }));
  const crossOriginMiddleware = cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has('*') || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS.'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600
  });
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      const forwardedHost = req.get('x-forwarded-host') || req.get('host');
      const forwardedProtocol = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
      try {
        if (new URL(origin).origin === `${forwardedProtocol}://${forwardedHost}`) return next();
      } catch {
        // Let the CORS middleware report malformed origins consistently.
      }
    }
    return crossOriginMiddleware(req, res, next);
  });
  app.use(express.json({ limit: '2mb', strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use((req, _res, next) => {
    if (!req.body) req.body = {};
    next();
  });

  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 240,
    standardHeaders: 'draft-8',
    legacyHeaders: false
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12,
    standardHeaders: 'draft-8',
    legacyHeaders: false
  });
  app.use('/api', generalLimiter);
  app.use('/api/auth', authLimiter);

  function isAdmin(email) {
    return administrators.has(email.toLowerCase());
  }

  async function requireUser(req, res, next) {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const claims = match && verifyToken(match[1], tokenSecret);
    if (!claims) return res.status(401).json({ error: 'Sign in to continue.' });

    try {
      const digest = tokenHash(match[1]);
      const { rows } = await pool.query(
        `SELECT id, email, display_name, created_at FROM users
         WHERE id = $1 AND NOT EXISTS (
           SELECT 1 FROM revoked_tokens WHERE token_hash = $2 AND expires_at > now()
         )`,
        [Number(claims.sub), digest]
      );
      if (!rows[0]) return res.status(401).json({ error: 'This account is no longer available.' });
      req.user = rows[0];
      req.tokenHash = digest;
      req.tokenExpiresAt = claims.exp;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  function isLevelId(id) {
    return /^\d+$/.test(id) && Number.isSafeInteger(Number(id));
  }

  app.get('/api/health', async (_req, res, next) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'connected' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/register', async (req, res, next) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const displayName = typeof req.body.display_name === 'string' ? req.body.display_name.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (displayName.length < 2 || displayName.length > 32) {
      return res.status(400).json({ error: 'Display name must be 2–32 characters.' });
    }
    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be 10–128 characters.' });
    }

    try {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = passwordHash(password, salt);
      const { rows } = await pool.query(
        `INSERT INTO users (email, display_name, password_salt, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, created_at`,
        [email, displayName, salt, hash]
      );
      const user = rows[0];
      res.status(201).json({ token: createToken(user, tokenSecret), user: cleanUser(user) });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
      return next(error);
    }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (password.length > 128) return res.status(400).json({ error: 'Password must be 128 characters or fewer.' });

    try {
      const { rows } = await pool.query(
        `SELECT id, email, display_name, created_at, password_salt, password_hash
         FROM users WHERE email = $1`,
        [email]
      );
      const user = rows[0];
      const salt = user?.password_salt || '00000000000000000000000000000000';
      const stored = user?.password_hash || '0'.repeat(128);
      const attempted = passwordHash(password, salt);
      const matches = crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(attempted, 'hex'));
      if (!user || !matches) return res.status(401).json({ error: 'Email or password is incorrect.' });
      return res.json({ token: createToken(user, tokenSecret), user: cleanUser(user) });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/auth/me', requireUser, (req, res) => {
    res.json({ user: cleanUser(req.user), isAdmin: isAdmin(req.user.email) });
  });

  app.post('/api/auth/logout', requireUser, async (req, res, next) => {
    try {
      await pool.query(
        `INSERT INTO revoked_tokens (token_hash, expires_at)
         VALUES ($1, $2)
         ON CONFLICT (token_hash) DO NOTHING`,
        [req.tokenHash, new Date(req.tokenExpiresAt * 1000)]
      );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/levels', (req, res) => {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Math.min(50, Math.max(1, Number.isSafeInteger(requestedLimit) ? requestedLimit : 20));
    const offset = Math.max(0, Number.isSafeInteger(requestedOffset) ? requestedOffset : 0);
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const filteredLevels = search
      ? levelsFromFile.filter((level) => (
        level.title.toLowerCase().includes(search.toLowerCase())
        || level.author.toLowerCase().includes(search.toLowerCase())
        || level.description.toLowerCase().includes(search.toLowerCase())
      ))
      : levelsFromFile;
    res.json({
      levels: filteredLevels.slice(offset, offset + limit),
      total: filteredLevels.length,
      limit,
      offset
    });
  });

  async function legacyLevelHandler(req, res, next) {
    const params = { ...req.query, ...req.body };
    const action = typeof params.action === 'string' ? params.action : '';
    if ((!params.level_id && !params.id) || action === 'get_featured') {
      return res.type('application/xml').send(levelCatalogXml);
    }
    const id = params.level_id || params.id;
    if (!isLevelId(String(id || ''))) return res.status(400).type('text/plain').send('A numeric level_id is required.');
    if (!params.action) params.action = 'get_level';

    if (!levelsFromFile.some((level) => level.id === Number(id))) {
      return res.status(404).type('text/plain').send('Level not found.');
    }
    try {
      const upstream = await loadOfficialLevel(String(id), params);
      if (upstream.status < 200 || upstream.status >= 300) {
        return res.status(502).type('text/plain').send('The game level service could not load this level.');
      }
      if (/^\s*(?:<\?xml[^>]*>\s*)?<lvs(?:\s|>)/i.test(upstream.body)) {
        return res.status(502).type('text/plain').send('The game service returned catalogue metadata, not playable level data.');
      }
      return res.status(200).type(upstream.contentType || 'application/xml').send(upstream.body);
    } catch (error) {
      console.error('Could not load level from the game service:', error.message);
      return res.status(502).type('text/plain').send('The game level service could not load this level.');
    }
  }
  app.get('/get_level.hw', legacyLevelHandler);
  app.post('/get_level.hw', legacyLevelHandler);

  app.use(express.static(webRoot, { index: 'index.html' }));

  app.use((error, _req, res, _next) => {
    if (error.message === 'Origin is not allowed by CORS.') return res.status(403).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    console.error('Request failed:', error.message);
    return res.status(500).json({ error: 'The server could not complete that request.' });
  });

  return app;
}

async function loadLevelFromOfficialService(levelId, originalParams) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(originalParams)) {
    if (typeof value === 'string') params.set(key, value);
  }
  params.set('level_id', levelId);
  if (!params.has('action')) params.set('action', 'get_level');

  const response = await fetch('https://totaljerkface.com/get_level.hw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    signal: AbortSignal.timeout(15_000)
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text()
  };
}

async function start() {
  const port = Number(process.env.PORT || 3000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error.message));
  await initializeDatabase(pool);

  const app = createApp({ pool });
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Wheels Happy website and API listening on port ${port}`);
  });
  const shutdown = () => server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Could not start Wheels Happy service:', error.message);
    process.exit(1);
  });
}

module.exports = { createApp, initializeDatabase };
