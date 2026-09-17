// 课表数据隔离模块
// 当 DATABASE_URL 存在时使用 Postgres 存储，否则使用本地文件

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

const SUPER_SCHEDULE_FILE = path.join(DATA_DIR, 'schedule_super.json');
const SUPER_TEMPLATE_FILE = path.join(UPLOAD_DIR, 'template_super.xlsx');
const OLD_SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');
const OLD_TEMPLATE_FILE = path.join(UPLOAD_DIR, 'template.xlsx');

function getScheduleFile(userId) {
  return path.join(DATA_DIR, `schedule_${userId}.json`);
}

function getTemplateFile(userId) {
  return path.join(UPLOAD_DIR, `template_${userId}.xlsx`);
}

// 按用户 ID 加载课表
async function loadSchedule(userId) {
  if (db.isPostgresEnabled()) {
    const p = db.getPool();
    const res = await p.query('SELECT data FROM schedules WHERE user_id = $1', [userId]);
    if (res.rows.length) return res.rows[0].data;
    // 超管首次加载尝试从旧文件迁移
    if (userId === 'super') {
      const migrated = migrateOldData();
      if (migrated) {
        await saveSchedule('super', migrated);
        return migrated;
      }
    }
    return null;
  }
  const file = userId === 'super' ? SUPER_SCHEDULE_FILE : getScheduleFile(userId);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    if (userId === 'super') return migrateOldData();
    return null;
  }
}

// 保存课表
async function saveSchedule(userId, data) {
  if (db.isPostgresEnabled()) {
    const p = db.getPool();
    await p.query(
      `INSERT INTO schedules (user_id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [userId, data]
    );
    return;
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = userId === 'super' ? SUPER_SCHEDULE_FILE : getScheduleFile(userId);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// 删除用户课表数据
async function deleteSchedule(userId) {
  if (db.isPostgresEnabled()) {
    const p = db.getPool();
    await p.query('DELETE FROM schedules WHERE user_id = $1', [userId]);
    await p.query('DELETE FROM templates WHERE user_id = $1', [userId]);
    return;
  }
  const file = getScheduleFile(userId);
  try { fs.unlinkSync(file); } catch {}
  const template = getTemplateFile(userId);
  try { fs.unlinkSync(template); } catch {}
}

// 获取用户的模板文件路径（仅本地文件模式使用）
function getTemplatePath(userId) {
  return userId === 'super' ? SUPER_TEMPLATE_FILE : getTemplateFile(userId);
}

// 获取模板 Buffer（Postgres 模式从 BYTEA 读取，文件模式从磁盘读取）
async function getTemplateBuffer(userId) {
  if (db.isPostgresEnabled()) {
    const p = db.getPool();
    const res = await p.query('SELECT file_data FROM templates WHERE user_id = $1', [userId]);
    if (res.rows.length) {
      // pg 返回 BYTEA 为 Buffer
      return res.rows[0].file_data;
    }
    return null;
  }
  const file = getTemplatePath(userId);
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// 检查模板是否存在
async function hasTemplate(userId) {
  if (db.isPostgresEnabled()) {
    const p = db.getPool();
    const res = await p.query('SELECT 1 FROM templates WHERE user_id = $1', [userId]);
    return res.rows.length > 0;
  }
  return fs.existsSync(getTemplatePath(userId));
}

// 保存模板 Buffer
async function saveTemplateBuffer(userId, buffer, fileName) {
  if (db.isPostgresEnabled()) {
    const p = db.getPool();
    await p.query(
      `INSERT INTO templates (user_id, file_data, file_name, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET file_data = $2, file_name = $3, updated_at = NOW()`,
      [userId, buffer, fileName || null]
    );
    return;
  }
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const file = getTemplatePath(userId);
  fs.writeFileSync(file, buffer);
}

// 教师访问：加载超管课表
async function loadPublicSchedule() {
  return loadSchedule('super');
}

// 教师访问：获取超管模板 Buffer
async function getPublicTemplateBuffer() {
  return getTemplateBuffer('super');
}

// 迁移旧数据（仅超管首次加载时，文件模式）
function migrateOldData() {
  try {
    const data = JSON.parse(fs.readFileSync(OLD_SCHEDULE_FILE, 'utf-8'));
    if (!fs.existsSync(SUPER_SCHEDULE_FILE)) {
      const file = SUPER_SCHEDULE_FILE;
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }
    if (fs.existsSync(OLD_TEMPLATE_FILE) && !fs.existsSync(SUPER_TEMPLATE_FILE)) {
      fs.copyFileSync(OLD_TEMPLATE_FILE, SUPER_TEMPLATE_FILE);
    }
    return data;
  } catch {
    return null;
  }
}

module.exports = {
  loadSchedule,
  saveSchedule,
  deleteSchedule,
  getTemplatePath,
  getTemplateBuffer,
  hasTemplate,
  saveTemplateBuffer,
  loadPublicSchedule,
  getPublicTemplateBuffer,
  SUPER_SCHEDULE_FILE,
  SUPER_TEMPLATE_FILE
};
