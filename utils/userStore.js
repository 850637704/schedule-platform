// 用户数据管理模块
// 当 DATABASE_URL 存在时使用 Postgres 存储，否则使用本地 data/users.json

const fs = require('fs');
const path = require('path');
const CryptoJS = require('crypto-js');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const SUPER_ADMIN_ACCOUNT = '17347363572';
const DEFAULT_PASSWORD = '990322';

// 哈希函数
function hashPassword(password) {
  return CryptoJS.SHA256(password).toString();
}

// 生成用户 ID
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 确保数据目录存在
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 读取用户数据（异步，兼容 Postgres 和本地文件）
async function loadUsers() {
  if (db.isPostgresEnabled()) {
    return await db.getJson('users');
  }
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

// 保存用户数据
async function saveUsers(data) {
  if (db.isPostgresEnabled()) {
    await db.setJson('users', data);
    return;
  }
  ensureDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// 初始化：首次启动创建默认超管账号
async function initUsers() {
  let data = await loadUsers();
  if (!data) {
    data = {
      superAdmin: {
        account: SUPER_ADMIN_ACCOUNT,
        passwords: [hashPassword(DEFAULT_PASSWORD)],
        securityQuestion: '默认安全问题，请修改',
        securityAnswer: hashPassword('默认答案')
      },
      admins: []
    };
    await saveUsers(data);
  }
  return data;
}

// 校验超管密码（支持多个密码）
async function verifySuperAdmin(account, password) {
  const data = await loadUsers();
  if (!data || !data.superAdmin) return null;
  if (data.superAdmin.account !== account) return null;
  const hash = hashPassword(password);
  if (data.superAdmin.passwords.includes(hash)) {
    return { type: 'super', account };
  }
  return null;
}

// 校验管理员密码
async function verifyAdmin(account, password) {
  const data = await loadUsers();
  if (!data || !data.admins) return null;
  const admin = data.admins.find(a => a.account === account);
  if (!admin) return null;
  const hash = hashPassword(password);
  if (admin.password === hash) {
    return { type: 'admin', account, id: admin.id };
  }
  return null;
}

// 通用登录校验
async function verifyUser(account, password) {
  return (await verifySuperAdmin(account, password)) || (await verifyAdmin(account, password));
}

// 添加管理员
async function addAdmin(account, password) {
  const data = await loadUsers();
  if (!data) return { error: '用户数据未初始化' };
  if (data.admins.some(a => a.account === account)) {
    return { error: '账号已存在' };
  }
  if (data.superAdmin.account === account) {
    return { error: '该账号为超管保留账号' };
  }
  const admin = {
    id: genId(),
    account,
    password: hashPassword(password),
    createdAt: new Date().toISOString()
  };
  data.admins.push(admin);
  await saveUsers(data);
  return { ok: true, id: admin.id };
}

// 删除管理员（返回被删除管理员的 ID 以便删除课表）
async function removeAdmin(id) {
  const data = await loadUsers();
  if (!data) return { error: '用户数据未初始化' };
  const idx = data.admins.findIndex(a => a.id === id);
  if (idx === -1) return { error: '管理员不存在' };
  data.admins.splice(idx, 1);
  await saveUsers(data);
  return { ok: true, id };
}

// 重置管理员密码
async function resetAdminPassword(id, newPassword) {
  const data = await loadUsers();
  if (!data) return { error: '用户数据未初始化' };
  const admin = data.admins.find(a => a.id === id);
  if (!admin) return { error: '管理员不存在' };
  admin.password = hashPassword(newPassword);
  await saveUsers(data);
  return { ok: true };
}

// 获取管理员列表（不含密码）
async function getAdminList() {
  const data = await loadUsers();
  if (!data) return [];
  return data.admins.map(a => ({
    id: a.id,
    account: a.account,
    createdAt: a.createdAt
  }));
}

// 超管新增密码
async function addSuperAdminPassword(password) {
  const data = await loadUsers();
  if (!data || !data.superAdmin) return { error: '超管数据不存在' };
  const hash = hashPassword(password);
  if (data.superAdmin.passwords.includes(hash)) {
    return { error: '该密码已存在' };
  }
  data.superAdmin.passwords.push(hash);
  await saveUsers(data);
  return { ok: true };
}

// 超管删除密码（990322 不可删）
async function removeSuperAdminPassword(hash) {
  const data = await loadUsers();
  if (!data || !data.superAdmin) return { error: '超管数据不存在' };
  const defaultHash = hashPassword(DEFAULT_PASSWORD);
  if (hash === defaultHash) {
    return { error: '默认密码 990322 不可删除' };
  }
  const idx = data.superAdmin.passwords.indexOf(hash);
  if (idx === -1) return { error: '密码不存在' };
  if (data.superAdmin.passwords.length <= 1) {
    return { error: '至少保留一个密码' };
  }
  data.superAdmin.passwords.splice(idx, 1);
  await saveUsers(data);
  return { ok: true };
}

// 获取超管密码列表（返回哈希，不含明文）
async function getSuperAdminPasswords() {
  const data = await loadUsers();
  if (!data || !data.superAdmin) return [];
  return data.superAdmin.passwords.map(h => ({ hash: h, isDefault: h === hashPassword(DEFAULT_PASSWORD) }));
}

// 重置超管为默认密码
async function resetSuperAdmin() {
  const data = await loadUsers();
  if (!data || !data.superAdmin) {
    await initUsers();
    return { ok: true };
  }
  data.superAdmin.passwords = [hashPassword(DEFAULT_PASSWORD)];
  await saveUsers(data);
  return { ok: true };
}

// 设置超管安全问题
async function setSecurityQuestion(question, answer) {
  const data = await loadUsers();
  if (!data || !data.superAdmin) return { error: '超管数据不存在' };
  data.superAdmin.securityQuestion = question;
  data.superAdmin.securityAnswer = hashPassword(answer);
  await saveUsers(data);
  return { ok: true };
}

// 获取安全问题
async function getSecurityQuestion() {
  const data = await loadUsers();
  if (!data || !data.superAdmin) return null;
  return data.superAdmin.securityQuestion || null;
}

// 验证安全问题答案
async function verifySecurityAnswer(answer) {
  const data = await loadUsers();
  if (!data || !data.superAdmin) return false;
  return data.superAdmin.securityAnswer === hashPassword(answer);
}

module.exports = {
  hashPassword,
  initUsers,
  loadUsers,
  saveUsers,
  verifyUser,
  verifySuperAdmin,
  verifyAdmin,
  addAdmin,
  removeAdmin,
  resetAdminPassword,
  getAdminList,
  addSuperAdminPassword,
  removeSuperAdminPassword,
  getSuperAdminPasswords,
  resetSuperAdmin,
  setSecurityQuestion,
  getSecurityQuestion,
  verifySecurityAnswer,
  SUPER_ADMIN_ACCOUNT,
  DEFAULT_PASSWORD
};
