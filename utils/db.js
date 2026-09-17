// 数据库连接模块
// 当 DATABASE_URL 环境变量存在时使用 Postgres（Neon 等），否则使用本地文件存储
// 这样本地开发无需数据库即可运行，部署时配置 DATABASE_URL 即可切换

const { Pool } = require('pg');

let pool = null;

function isPostgresEnabled() {
  return !!process.env.DATABASE_URL;
}

function getPool() {
  if (!pool) {
    const isLocal = process.env.DATABASE_URL.includes('localhost') ||
                    process.env.DATABASE_URL.includes('127.0.0.1');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

// 初始化表结构
async function initTables() {
  if (!isPostgresEnabled()) return;
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS schedules (
      user_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS templates (
      user_id TEXT PRIMARY KEY,
      file_data BYTEA NOT NULL,
      file_name TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('数据库表初始化完成');
}

// 通用：获取 JSONB 键值
async function getJson(key) {
  const p = getPool();
  const res = await p.query('SELECT value FROM app_data WHERE key = $1', [key]);
  return res.rows.length ? res.rows[0].value : null;
}

// 通用：保存 JSONB 键值
async function setJson(key, value) {
  const p = getPool();
  await p.query(
    `INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

module.exports = {
  isPostgresEnabled,
  getPool,
  initTables,
  getJson,
  setJson
};
