async function initializeDatabase(pool) {
  const statements = [
    `
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name VARCHAR(32) NOT NULL,
      password_salt CHAR(32) NOT NULL,
      password_hash CHAR(128) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      token_hash CHAR(64) PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx ON revoked_tokens (expires_at)'
  ];
  for (const statement of statements) await pool.query(statement);
  await pool.query('DELETE FROM revoked_tokens WHERE expires_at <= now()');
}

module.exports = { initializeDatabase };
