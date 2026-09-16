// 课表数据隔离模块
// 按用户 ID 分别存储课表数据，实现数据隔离

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// 超管课表文件路径
const SUPER_SCHEDULE_FILE = path.join(DATA_DIR, 'schedule_super.json');
// 超管模板文件路径
const SUPER_TEMPLATE_FILE = path.join(UPLOAD_DIR, 'template_super.xlsx');
// 旧的全局课表文件（用于迁移）
const OLD_SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');
const OLD_TEMPLATE_FILE = path.join(UPLOAD_DIR, 'template.xlsx');

// 获取管理员课表文件路径
function getScheduleFile(userId) {
  return path.join(DATA_DIR, `schedule_${userId}.json`);
}

// 获取管理员模板文件路径
function getTemplateFile(userId) {
  return path.join(UPLOAD_DIR, `template_${userId}.xlsx`);
}

// 按用户 ID 加载课表
function loadSchedule(userId) {
  const file = userId === 'super' ? SUPER_SCHEDULE_FILE : getScheduleFile(userId);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    // 尝试旧文件迁移（仅超管）
    if (userId === 'super') {
      return migrateOldData();
    }
    return null;
  }
}

// 保存课表到对应用户文件
function saveSchedule(userId, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = userId === 'super' ? SUPER_SCHEDULE_FILE : getScheduleFile(userId);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// 删除用户课表数据（删管理员时调用）
function deleteSchedule(userId) {
  const file = getScheduleFile(userId);
  try { fs.unlinkSync(file); } catch {}
  // 同时删除该用户的模板文件
  const template = getTemplateFile(userId);
  try { fs.unlinkSync(template); } catch {}
}

// 获取用户的模板文件路径
function getTemplatePath(userId) {
  return userId === 'super' ? SUPER_TEMPLATE_FILE : getTemplateFile(userId);
}

// 教师访问：加载超管课表
function loadPublicSchedule() {
  return loadSchedule('super');
}

// 教师访问：获取超管模板路径
function getPublicTemplatePath() {
  return SUPER_TEMPLATE_FILE;
}

// 迁移旧数据（仅超管首次加载时）
function migrateOldData() {
  try {
    const data = JSON.parse(fs.readFileSync(OLD_SCHEDULE_FILE, 'utf-8'));
    // 迁移到超管文件
    if (!fs.existsSync(SUPER_SCHEDULE_FILE)) {
      saveSchedule('super', data);
    }
    // 迁移模板文件
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
  loadPublicSchedule,
  getPublicTemplatePath,
  SUPER_SCHEDULE_FILE,
  SUPER_TEMPLATE_FILE
};
