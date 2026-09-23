const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

const { parseWorkbook, buildTeacherMap } = require('./utils/parser');
const XLSX = require('xlsx');
const { analyzeConflicts, getStats } = require('./utils/analyzer');
const { teacherStatistics, classStatistics } = require('./utils/statistics');
const {
  exportClassSchedules, exportTeacherSchedules,
  exportSingleClass, exportSingleTeacher, exportTeacherStatistics, exportClassStatistics,
  exportTeacherArrangement
} = require('./utils/exporter');
const {
  computeSwapCandidates, executeSwap, getTeacherEntries, getPeriodLabels
} = require('./utils/swap');
const {
  modifyWorkbookOnSwap, appendSwapRecord, getSwapRecords, removeLastSwapRecord, getGradeLevel, WEEKDAY_NAMES: WB_WEEKDAY_NAMES
} = require('./utils/workbookWriter');
const userStore = require('./utils/userStore');
const scheduleStore = require('./utils/scheduleStore');
const { requireLogin, requireSuperAdmin, getCurrentUser, getScheduleUserId } = require('./utils/auth');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// 初始化用户数据（首次启动创建默认超管账号）
userStore.initUsers();

// Session 配置
app.use(session({
  secret: 'schedule-platform-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 2 * 60 * 60 * 1000 }  // 默认2小时过期
}));

app.use(express.json());
// 开发期间禁用静态文件缓存，确保每次都加载最新版本
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
// 静态资源不缓存，确保前端修改后刷新即可生效
// 处理预览环境注入的 Vite HMR 客户端请求，避免返回 HTML 导致 JS 解析错误
app.get('/@vite/client', (req, res) => {
  res.type('application/javascript').send('');
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
  }
}));

// 设置带中文文件名的下载头（RFC 5987）
function setDownloadHeader(res, filename) {
  const encoded = encodeURIComponent(filename);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
}

// 修复 multer/busboy 对中文文件名的 latin1 解码问题
function fixFilename(name) {
  if (!name) return name;
  // multer 默认按 latin1 解码，需转回 UTF-8
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    // 若解码后含替换字符，说明原编码不是 UTF-8，尝试 GBK
    if (decoded.includes('\uFFFD')) {
      const iconv = require('iconv-lite');
      const gbkDecoded = iconv.decode(Buffer.from(name, 'latin1'), 'gbk');
      if (!gbkDecoded.includes('\uFFFD')) return gbkDecoded;
    }
    return decoded;
  } catch (e) {
    return name;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(fixFilename(file.originalname));
      cb(null, `upload_${Date.now()}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const name = fixFilename(file.originalname);
    if (/xlsx|xls|csv/.test(path.extname(name).toLowerCase())) cb(null, true);
    else cb(new Error('仅支持 .xlsx / .xls / .csv 文件'));
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

// 读取/保存课表数据（按用户隔离）
function loadData(req) {
  const userId = getScheduleUserId(req);
  return scheduleStore.loadSchedule(userId);
}
function saveScheduleData(req, data) {
  const userId = getScheduleUserId(req);
  scheduleStore.saveSchedule(userId, data);
}

// 按周次过滤课表数据，返回该周的条目与所用周次
function filterByWeek(data, week) {
  if (!data) return { entries: [], week: null, weeks: [] };
  const weeks = data.weeks || ['通用'];
  const w = (week && weeks.includes(week)) ? week : weeks[0];
  const entries = data.entries.filter(e => (e.weekType || '通用') === w);
  return { entries, week: w, weeks };
}

// ============ 认证 API ============

// 登录
app.post('/api/login', (req, res) => {
  const { account, password, remember } = req.body;
  if (!account || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const user = userStore.verifyUser(account, password);
  if (!user) return res.status(401).json({ error: '账号或密码错误' });
  req.session.user = user;
  // 勾选"记住账号密码"：cookie 30天有效；未勾选：session cookie（浏览器关闭时过期）
  if (remember) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30天
  } else {
    req.session.cookie.expires = null;  // session cookie（浏览器关闭时过期）
    req.session.cookie.maxAge = null;
  }
  res.json({ ok: true, user: { type: user.type, account: user.account } });
});

// 退出登录
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// 获取当前登录状态
app.get('/api/me', (req, res) => {
  const user = getCurrentUser(req);
  if (user) {
    res.json({ loggedIn: true, type: user.type, account: user.account });
  } else {
    res.json({ loggedIn: false });
  }
});

// ============ Logo 上传 API（仅超管） ============

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'public'),
    filename: (req, file, cb) => {
      const ext = path.extname(fixFilename(file.originalname)) || '.png';
      cb(null, `logo${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(fixFilename(file.originalname)).toLowerCase();
    if (/\.(png|jpg|jpeg|gif|webp|svg)$/.test(ext)) cb(null, true);
    else cb(new Error('仅支持图片文件（png/jpg/jpeg/gif/webp/svg）'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/api/upload-logo', requireSuperAdmin, logoUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传图片文件' });
  // 删除旧 logo 文件（非当前上传的）
  const ext = path.extname(req.file.filename);
  const publicDir = path.join(__dirname, 'public');
  fs.readdirSync(publicDir).forEach(f => {
    if (/^logo\.(png|jpg|jpeg|gif|webp|svg)$/.test(f) && f !== req.file.filename) {
      try { fs.unlinkSync(path.join(publicDir, f)); } catch {}
    }
  });
  // 前端加时间戳防止缓存
  res.json({ ok: true, path: `/${req.file.filename}?t=${Date.now()}` });
});

// ============ 账号管理 API（仅超管） ============

// 获取管理员列表
app.get('/api/admin/accounts', requireSuperAdmin, (req, res) => {
  res.json({ accounts: userStore.getAdminList() });
});

// 添加管理员
app.post('/api/admin/accounts', requireSuperAdmin, (req, res) => {
  const { account, password } = req.body;
  if (!account || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const result = userStore.addAdmin(account, password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, id: result.id });
});

// 删除管理员（同时删除课表数据）
app.delete('/api/admin/accounts/:id', requireSuperAdmin, (req, res) => {
  const { id } = req.params;
  const result = userStore.removeAdmin(id);
  if (result.error) return res.status(400).json({ error: result.error });
  // 删除该管理员的课表数据
  scheduleStore.deleteSchedule(id);
  res.json({ ok: true });
});

// 重置管理员密码
app.put('/api/admin/accounts/:id/password', requireSuperAdmin, (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '请输入新密码' });
  const result = userStore.resetAdminPassword(id, password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// 超管密码管理
app.get('/api/super/passwords', requireSuperAdmin, (req, res) => {
  res.json({ passwords: userStore.getSuperAdminPasswords() });
});

app.post('/api/super/passwords', requireSuperAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '请输入密码' });
  const result = userStore.addSuperAdminPassword(password);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

app.delete('/api/super/passwords/:hash', requireSuperAdmin, (req, res) => {
  const { hash } = req.params;
  const result = userStore.removeSuperAdminPassword(hash);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// 隐藏接口：通过安全问题重置超管密码
app.post('/api/reset-super', (req, res) => {
  const { answer } = req.body;
  if (!answer) return res.status(400).json({ error: '请回答安全问题' });
  if (!userStore.verifySecurityAnswer(answer)) {
    return res.status(401).json({ error: '安全答案错误' });
  }
  userStore.resetSuperAdmin();
  res.json({ ok: true, message: '超管密码已重置为 990322' });
});

// 获取安全问题（未登录可访问）
app.get('/api/security-question', (req, res) => {
  const q = userStore.getSecurityQuestion();
  res.json({ question: q || '未设置安全问题' });
});

// ============ 课表 API ============

// 上传并解析总课表（需登录）
app.post('/api/upload', requireLogin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  try {
    const { entries, sheets, weeks, teacherMap, teacherSubjects, meetings, leaves, swapRecords, schedule8 } = parseWorkbook(req.file.path);
    if (!entries.length) {
      return res.status(400).json({ error: '未能从文件中解析出课表数据，请检查文件格式。需要包含「总课表」和「教师安排」工作表。' });
    }
    const stats = getStats(entries);
    const data = {
      uploadedAt: new Date().toISOString(),
      filename: fixFilename(req.file.originalname),
      sheets,
      entries,
      stats,
      weeks: weeks || ['通用'],
      teacherMap: teacherMap || {},
      teacherSubjects: teacherSubjects || [],
      meetings: meetings || [],
      leaves: leaves || [],
      swapRecords: swapRecords || [],
      schedule8: schedule8 || {}
    };
    saveScheduleData(req, data);
    // 保存上传的文件作为模板（覆盖旧的）
    const templatePath = scheduleStore.getTemplatePath(getScheduleUserId(req));
    fs.copyFileSync(req.file.path, templatePath);
    res.json({ ok: true, ...stats, sheets, weeks: data.weeks, uploadedAt: data.uploadedAt, meetings: data.meetings || [], leaves: data.leaves || [], swapRecords: data.swapRecords });
  } catch (err) {
    res.status(500).json({ error: '解析失败：' + err.message });
  } finally {
    // 清理上传临时文件
    fs.unlink(req.file.path, () => {});
  }
});

// 获取可用周次
app.get('/api/weeks', (req, res) => {
  const data = loadData(req);
  if (!data) return res.json({ weeks: [] });
  res.json({ weeks: data.weeks || ['通用'] });
});

// 获取概览信息（按周次过滤）
app.get('/api/overview', (req, res) => {
  const data = loadData(req);
  if (!data) return res.json({ hasData: false, weeks: [] });
  const { entries, week, weeks } = filterByWeek(data, req.query.week);
  // totalEntries 按周次统计，teacherCount/subjectCount/classCount 基于全量统计
  const weekStats = getStats(entries);
  const allStats = getStats(data.entries);
  // 科目数优先使用教师安排表的科目（更准确），课表可能含"班会"等非教学科目
  const teacherSubjectsList = (() => {
    if (data.teacherSubjects && data.teacherSubjects.length) return data.teacherSubjects;
    try {
      const templatePath = scheduleStore.getTemplatePath(getScheduleUserId(req));
      if (fs.existsSync(templatePath)) {
        const wb = XLSX.readFile(templatePath);
        const tName = wb.SheetNames.find(n => /教师安排/.test(n));
        if (tName) {
          const { subjects } = buildTeacherMap(wb.Sheets[tName]);
          if (subjects && subjects.length) return subjects;
        }
      }
    } catch {}
    return [...new Set(Object.values(data.teacherMap || {}).flatMap(info => Object.keys(info).filter(k => !k.startsWith('_'))))];
  })();
  res.json({
    hasData: true,
    totalEntries: weekStats.totalEntries,
    classCount: allStats.classCount,
    teacherCount: allStats.teacherCount,
    subjectCount: teacherSubjectsList.length,
    classes: allStats.classes,
    teachers: allStats.teachers,
    subjects: teacherSubjectsList,
    uploadedAt: data.uploadedAt,
    filename: data.filename,
    weeks,
    week,
    teacherMap: data.teacherMap || {},
    teacherSubjects: teacherSubjectsList
  });
});

// 获取所有班级列表
app.get('/api/classes', (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据，请先上传' });
  const { entries } = filterByWeek(data, req.query.week);
  // 班级列表：从课表条目 + 教师安排表中合并，确保无课表但有教师安排的班级也显示
  // 班级名以课表原始格式为准（如"2401班"），teacherMap 的 key 是归一化的（如"2401"），需补"班"字
  const classSet = new Set(getStats(entries).classes);
  if (data.teacherMap) {
    for (const code of Object.keys(data.teacherMap)) {
      if (code) {
        // teacherMap 的 key 是归一化的，补"班"字以匹配课表显示格式
        const displayCode = /班$/.test(code) ? code : code + '班';
        classSet.add(displayCode);
      }
    }
  }
  res.json({ classes: [...classSet].sort() });
});

// 获取所有教师列表
app.get('/api/teachers', (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据，请先上传' });
  // 教师列表不按周次过滤，展示所有教师（合并课表条目 + 教师安排表中的教师）
  const teacherSet = new Set(getStats(data.entries).teachers);
  // 补充教师安排表中可能未在课表出现的教师
  if (data.teacherMap) {
    for (const info of Object.values(data.teacherMap)) {
      for (const val of Object.values(info)) {
        if (val && typeof val === 'string') teacherSet.add(val);
      }
    }
  }
  res.json({ teachers: [...teacherSet].sort() });
});

// 获取班级课表（含教师配置表）
app.get('/api/class/:className', (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const className = decodeURIComponent(req.params.className);
  const { entries } = filterByWeek(data, req.query.week);
  const filtered = entries.filter(e => e.class === className);
  // 该班级的教师配置（科目 -> 教师）
  // teacherMap 的 key 是归一化的班级名（如"2401"），className 可能是"2401班"，需归一化查找
  const normClassName = className.replace(/班$/, '');
  const teacherConfig = data.teacherMap && data.teacherMap[normClassName]
    ? data.teacherMap[normClassName] : {};
  // 全局节次标签（所有课表共用同一节次行，从全部条目中提取）
  const periodLabels = {};
  for (const e of entries) {
    if (e.periodLabel && !(e.period in periodLabels)) periodLabels[e.period] = e.periodLabel;
  }
  // 作息时间（8作息时间表）
  const schedule8 = data.schedule8 && data.schedule8[className] ? data.schedule8[className] : {};
  res.json({ class: className, entries: filtered, count: filtered.length, teacherConfig, periodLabels, schedule8 });
});

// 获取教师课表
app.get('/api/teacher/:teacherName', (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const teacherName = decodeURIComponent(req.params.teacherName);
  const { entries } = filterByWeek(data, req.query.week);
  const filtered = entries.filter(e => e.teacher === teacherName);
  // 全局节次标签
  const periodLabels = {};
  for (const e of entries) {
    if (e.periodLabel && !(e.period in periodLabels)) periodLabels[e.period] = e.periodLabel;
  }
  // 检测该教师的会议冲突（教师在会议时间被排课）
  const meetings = data.meetings || [];
  const teacherMap = data.teacherMap || {};
  const { MEETING_SUBJECT_MAP } = require('./utils/parser');
  // 构建 科目 -> 教师列表 映射
  const subjectTeachers = {};
  for (const [code, info] of Object.entries(teacherMap)) {
    for (const [key, val] of Object.entries(info)) {
      if (key === '_班主任') {
        if (!subjectTeachers._班主任) subjectTeachers._班主任 = new Set();
        subjectTeachers._班主任.add(val);
        continue;
      }
      if (!subjectTeachers[key]) subjectTeachers[key] = new Set();
      if (val) subjectTeachers[key].add(val);
      // 同时注册去掉(单周)/(双周)后缀的基础科目名，便于会议匹配
      const baseKey = key.replace(/[(（].*?[)）]/g, '').trim();
      if (baseKey && baseKey !== key) {
        if (!subjectTeachers[baseKey]) subjectTeachers[baseKey] = new Set();
        if (val) subjectTeachers[baseKey].add(val);
      }
    }
  }
  // 找到该教师参与的会议
  const myMeetings = [];
  for (const meeting of meetings) {
    const meetingSubjects = MEETING_SUBJECT_MAP[meeting.name] || [];
    for (const subj of meetingSubjects) {
      if (subjectTeachers[subj] && subjectTeachers[subj].has(teacherName)) {
        myMeetings.push(meeting);
        break;
      }
    }
  }
  // 检查该教师在会议时间是否被排课（去重）
  // 注意：只检查当前教师自己的课程（filtered），不能用 entries（所有教师的课程）
  const meetingConflictSet = new Set();
  const meetingConflicts = [];
  for (const meeting of myMeetings) {
    for (const entry of filtered) {
      const key = `${meeting.weekday}|${entry.period}|${meeting.name}`;
      if (entry.weekday === meeting.weekday && entry.periodLabel === meeting.periodLabel) {
        if (!meetingConflictSet.has(key)) {
          meetingConflictSet.add(key);
          meetingConflicts.push({
            weekday: entry.weekday,
            period: entry.period,
            meetingName: meeting.name,
            weekType: entry.weekType || '通用'
          });
        }
      }
    }
  }
  // 该教师需参加的所有会议时间（不只是冲突的，用于水印展示）
  // myMeetings 已按节次展开（每个节次一个条目），通过 periodLabel 反查 period 序号
  // 构建 periodLabel -> period 序号 映射
  const labelToPeriod = {};
  for (const e of entries) {
    if (e.periodLabel && !(e.periodLabel in labelToPeriod)) labelToPeriod[e.periodLabel] = e.period;
  }
  const teacherMeetings = [];
  const tmSet = new Set();
  for (const meeting of myMeetings) {
    const p = labelToPeriod[meeting.periodLabel];
    if (p == null) continue;
    const key = `${meeting.weekday}|${p}`;
    if (!tmSet.has(key)) {
      tmSet.add(key);
      teacherMeetings.push({
        weekday: meeting.weekday,
        period: p,
        meetingName: meeting.name
      });
    }
  }
  // 检测该教师的调休冲突（仅单周有效）
  const leaves = data.leaves || [];
  const weekType = req.query.week || '通用';
  const leaveConflictKeys = new Set();
  if (leaves.length && (weekType === '单周' || weekType === '通用')) {
    const myLeaveDays = new Set();
    for (const l of leaves) {
      if (l.teacher === teacherName && l.weekday) myLeaveDays.add(l.weekday);
    }
    for (const e of filtered) {
      if (myLeaveDays.has(e.weekday)) {
        leaveConflictKeys.add(`${e.weekday}|${e.period}`);
      }
    }
  }
  // 汇总该教师的所有冲突（用于课表下方文字提示）
  const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周天'];
  const conflicts = [];
  // 1. 重课冲突：同一时段被排到多个班级
  const slotMap = new Map();
  for (const e of filtered) {
    const k = `${e.weekday}|${e.period}`;
    if (!slotMap.has(k)) slotMap.set(k, []);
    slotMap.get(k).push(e);
  }
  for (const [k, arr] of slotMap) {
    const classSet = new Set(arr.map(e => e.class).filter(Boolean));
    if (classSet.size > 1) {
      const [wd, p] = k.split('|').map(Number);
      const label = arr[0].periodLabel || `第${p}节`;
      conflicts.push({
        type: 'schedule',
        weekday: wd, period: p, periodLabel: label,
        detail: `${weekdayNames[wd]} ${label} 同时被安排到 ${[...classSet].join('、')} 等多个班级，存在重课冲突`
      });
    }
  }
  // 2. 会议冲突
  for (const mc of meetingConflicts) {
    const slotArr = slotMap.get(`${mc.weekday}|${mc.period}`) || [];
    const label = slotArr[0]?.periodLabel || mc.periodLabel || `第${mc.period}节`;
    conflicts.push({
      type: 'meeting',
      weekday: mc.weekday, period: mc.period, periodLabel: label,
      detail: `${weekdayNames[mc.weekday]} ${label} 有「${mc.meetingName}」，但同时被排了课，存在会议冲突`
    });
  }
  // 3. 调休冲突
  for (const key of leaveConflictKeys) {
    const [wd, p] = key.split('|').map(Number);
    const slotArr = slotMap.get(key) || [];
    const label = slotArr[0]?.periodLabel || `第${p}节`;
    const subjects = [...new Set(slotArr.map(e => e.subject).filter(Boolean))].join('、');
    conflicts.push({
      type: 'leave',
      weekday: wd, period: p, periodLabel: label,
      detail: `${weekdayNames[wd]} ${label} 是该教师的调休时间，但被安排了 ${subjects || '课程'}，存在调休冲突`
    });
  }
  // 按冲突严重性排序：重课(schedule) > 会议(meeting) > 调休(leave)
  const severityOrder = { schedule: 0, meeting: 1, leave: 2 };
  conflicts.sort((a, b) => (severityOrder[a.type] ?? 9) - (severityOrder[b.type] ?? 9));
  // 作息时间（8作息时间表）- 返回该教师所教班级的作息时间
  const teacherClasses = [...new Set(filtered.map(e => e.class))];
  const schedule8 = {};
  for (const cls of teacherClasses) {
    if (data.schedule8 && data.schedule8[cls]) schedule8[cls] = data.schedule8[cls];
  }
  res.json({ teacher: teacherName, entries: filtered, count: filtered.length, periodLabels, meetingConflicts, teacherMeetings, leaveConflictKeys: [...leaveConflictKeys], conflicts, schedule8 });
});

// 教师课时统计
app.get('/api/statistics/teachers', (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const { entries } = filterByWeek(data, req.query.week);
  const stats = teacherStatistics(entries);
  res.json({ teachers: stats });
});

// 班级课时统计
app.get('/api/statistics/classes', (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const { entries } = filterByWeek(data, req.query.week);
  const stats = classStatistics(entries);
  res.json({ classes: stats });
});

// 课表冲突分析
app.get('/api/analysis', (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  // 冲突分析同时检测单周和双周，不过滤周次
  const result = analyzeConflicts(data.entries || [], data.meetings || [], data.teacherMap || {}, data.leaves || []);
  res.json(result);
});

// 导出所有班级课表
app.get('/api/export/classes', async (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const { entries, week } = filterByWeek(data, req.query.week);
    const globalPeriodLabels = getPeriodLabels(entries);
    const buffer = await exportClassSchedules(entries, data.teacherMap, globalPeriodLabels);
    setDownloadHeader(res, `班级课表-${week}.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 导出所有教师课表
app.get('/api/export/teachers', async (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const { entries, week } = filterByWeek(data, req.query.week);
    const globalPeriodLabels = getPeriodLabels(entries);
    const buffer = await exportTeacherSchedules(entries, data.meetings, data.teacherMap, data.leaves, globalPeriodLabels, week);
    setDownloadHeader(res, `教师课表-${week}.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 导出教师安排表（Excel）
app.get('/api/export/teacher-arrangement', async (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const teacherMap = data.teacherMap || {};
    let subjects = data.teacherSubjects || [];
    // 如果没有科目列表，从 teacherMap 推断
    if (!subjects.length) {
      const subjectSet = new Set();
      for (const info of Object.values(teacherMap)) {
        for (const key of Object.keys(info)) {
          if (key !== '_班主任' && key !== '_grade') subjectSet.add(key);
        }
      }
      subjects = [...subjectSet];
    }
    if (!Object.keys(teacherMap).length) {
      return res.status(400).json({ error: '无教师安排数据' });
    }
    const buffer = await exportTeacherArrangement(teacherMap, subjects);
    setDownloadHeader(res, '教师安排.xlsx');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 导出单个班级课表
app.get('/api/export/class/:className', async (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const className = decodeURIComponent(req.params.className);
    const { entries, week } = filterByWeek(data, req.query.week);
    const globalPeriodLabels = getPeriodLabels(entries);
    const buffer = await exportSingleClass(entries, className, data.teacherMap, globalPeriodLabels, data.schedule8);
    // 高三班级单双周课表不同，标明周次；高一高二单双周相同，标"单双周"
    const isGrade3 = /^24\d{2}/.test(className) || /^高三/.test(className);
    const weekLabel = isGrade3 ? week : '单双周';
    setDownloadHeader(res, `${className}_${weekLabel}_课表.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 导出单个教师课表
app.get('/api/export/teacher/:teacherName', async (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const teacherName = decodeURIComponent(req.params.teacherName);
    const { entries, week } = filterByWeek(data, req.query.week);
    const globalPeriodLabels = getPeriodLabels(entries);
    const buffer = await exportSingleTeacher(entries, teacherName, data.meetings, data.teacherMap, data.leaves, globalPeriodLabels, week, data.schedule8);
    // 高三教师单双周课表不同，标明周次；高一高二教师单双周相同，标"单双周"
    const teacherEntries = data.entries.filter(e => e.teacher === teacherName);
    const isGrade3 = teacherEntries.some(e => /^24\d{2}/.test(e.class || '') || /^高三/.test(e.class || ''));
    const weekLabel = isGrade3 ? week : '单双周';
    setDownloadHeader(res, `${teacherName}_${weekLabel}_课表.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 导出教师课时统计
app.get('/api/export/teacher-stats', async (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const { entries, week } = filterByWeek(data, req.query.week);
    let stats = teacherStatistics(entries);
    // 支持按单个教师筛选导出
    if (req.query.teacher) {
      stats = stats.filter(t => t.teacher === req.query.teacher);
    }
    const buffer = await exportTeacherStatistics(stats);
    const name = req.query.teacher ? `${req.query.teacher}课时统计-${week}` : `教师课时统计-${week}`;
    setDownloadHeader(res, `${name}.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 导出班级课时统计
app.get('/api/export/class-stats', async (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const { entries, week } = filterByWeek(data, req.query.week);
    let stats = classStatistics(entries);
    // 支持按单个班级筛选导出
    if (req.query.class) {
      stats = stats.filter(c => c.class === req.query.class);
    }
    const buffer = await exportClassStatistics(stats);
    const name = req.query.class ? `${req.query.class}课时统计-${week}` : `班级课时统计-${week}`;
    setDownloadHeader(res, `${name}.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 下载模板：优先使用最近上传的课表文件，没有则生成默认模板
app.get('/api/template', async (req, res) => {
  try {
    // 获取对应用户的模板文件
    const templatePath = scheduleStore.getTemplatePath(getScheduleUserId(req));
    if (fs.existsSync(templatePath)) {
      setDownloadHeader(res, '课表模板.xlsx');
      return res.sendFile(templatePath);
    }
    // 没有上传过则生成默认模板（匹配真实课表模版格式）
    const wb = new ExcelJS.Workbook();
    wb.creator = '课表管理平台';
    const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周天'];
    const PERIODS = ['早自习', '第1节', '第2节', '第3节', '第4节', '第5节', '第6节', '第7节', '第8节', '晚1节', '晚2节', '晚3节', '晚4节'];
    const PERIODS_PER_DAY = PERIODS.length; // 13
    const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '音乐', '美术', '信息', '心理', '体育', '自习'];
    const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

    // 构建日期行和节次行
    const dateRow = ['日期'];
    const periodRow = ['节次'];
    for (let d = 0; d < DAYS.length; d++) {
      dateRow.push(DAYS[d]);
      for (let p = 0; p < PERIODS_PER_DAY - 1; p++) dateRow.push(null);
      for (let p = 0; p < PERIODS_PER_DAY; p++) periodRow.push(PERIODS[p]);
    }

    // 示例班级数据（2个班级，科目交替排列）
    const sampleClasses = [
      { code: '2401班', row: [
        '英语','生物','生物','数学','数学','物理','物理','英语','班会','英语','英语','语文','语文',
        '语文','语文','语文','英语','英语','化学','化学','数学','数学','化学','化学','生物','生物',
        '语文','生物','生物','英语','英语','体育','物理','物理','语文','数学','数学','物理','物理',
        '英语','化学','化学','数学','数学','语文','语文','物理','物理','化学','化学','英语','自习',
        '英语','语文','语文','英语','英语','物理','物理','化学','化学','物理','物理','语文','自习',
        '语文','生物','生物','英语','英语','语文','语文','数学','数学','生物','生物','数学','数学',
        '生物','生物','数学','数学','体育','化学','化学','物理','自习','物理','数学','数学','语文'
      ] },
      { code: '2402班', row: [
        '语文','英语','英语','物理','物理','体育','生物','生物','班会','语文','语文','数学','数学',
        '英语','英语','英语','语文','语文','数学','数学','物理','物理','生物','生物','化学','化学',
        '英语','物理','物理','数学','数学','化学','化学','语文','英语','物理','自习','数学','数学',
        '语文','语文','语文','数学','数学','生物','生物','化学','化学','英语','英语','数学','数学',
        '语文','物理','物理','化学','化学','语文','语文','英语','英语','化学','化学','物理','物理',
        '英语','数学','数学','英语','英语','生物','生物','语文','语文','语文','英语','生物','生物',
        '化学','化学','物理','体育','数学','数学','生物','生物','自习','自习','物理','物理','语文'
      ] }
    ];

    // 1单周总课表 & 2双周总课表
    for (const weekType of ['1单周总课表', '2双周总课表']) {
      const sheet = wb.addWorksheet(weekType);
      const title = weekType.replace(/^\d+/, '');
      sheet.addRow([title]);
      sheet.addRow(dateRow);
      sheet.addRow(periodRow);
      for (const c of sampleClasses) sheet.addRow([c.code, ...c.row]);
      // 合并标题行 A1:CN1
      sheet.mergeCells(1, 1, 1, 1 + DAYS.length * PERIODS_PER_DAY);
      // 合并日期行每个星期名
      for (let d = 0; d < DAYS.length; d++) {
        const startCol = 2 + d * PERIODS_PER_DAY;
        sheet.mergeCells(2, startCol, 2, startCol + PERIODS_PER_DAY - 1);
      }
      // 标题行样式
      sheet.getRow(1).getCell(1).font = { bold: true, size: 14 };
      sheet.getRow(1).getCell(1).alignment = { horizontal: 'center' };
      // 日期行和节次行样式
      for (const r of [2, 3]) {
        sheet.getRow(r).eachCell({ includeEmpty: true }, cell => {
          cell.font = { ...HEADER_FONT };
          cell.fill = { ...HEADER_FILL };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });
      }
      sheet.getRow(3).height = 35;
      sheet.getColumn(1).width = 8;
    }

    // 3教师安排
    const tSheet = wb.addWorksheet('3教师安排');
    tSheet.addRow(['班级', '班主任', ...SUBJECTS]);
    tSheet.addRow(['2401班', '杨良英', '姚绍兰', '刘婷', '李琼英', '姚伟', '杨良英', '周晓明', '', '', '', '', '', '', '', '杨晓鑫', '杨良英']);
    tSheet.addRow(['2402班', '周晓明', '姚绍兰', '程远新', '唐思莲', '姚伟', '杨良英', '周晓明', '', '', '', '', '', '', '', '杨晓鑫', '周晓明']);
    tSheet.getRow(1).eachCell(cell => {
      cell.font = { ...HEADER_FONT };
      cell.fill = { ...HEADER_FILL };
      cell.alignment = { horizontal: 'center' };
    });
    tSheet.getColumn(1).width = 10;
    tSheet.columns.forEach((col, i) => { if (i > 0) col.width = 10; });

    // 4会议时间
    const mSheet = wb.addWorksheet('4会议时间');
    const meetingDateRow = ['星期', ...dateRow.slice(1)];
    mSheet.addRow(meetingDateRow);
    mSheet.addRow(periodRow);
    // 会议行：在对应节次列填会议名称
    const meetingRow = ['会议'];
    // 填充会议名称到对应位置（与真实模版一致）
    const meetings = [
      { col: 5, name: '班主任会' },   // 周一第3节
      { col: 7, name: '语文组会' },   // 周一第5节
      { col: 16, name: '理综组会' },  // 周二第1节
      { col: 20, name: '英语组会' },  // 周二第5节
      { col: 31, name: '文综组会' },  // 周三第2节
      { col: 33, name: '数学组会' },  // 周三第4节
      { col: 42, name: '艺体组会' }, // 周四第1节
    ];
    for (const m of meetings) {
      meetingRow[m.col - 1] = m.name;
    }
    mSheet.addRow(meetingRow);
    // 合并日期行每个星期名
    for (let d = 0; d < DAYS.length; d++) {
      const startCol = 2 + d * PERIODS_PER_DAY;
      mSheet.mergeCells(1, startCol, 1, startCol + PERIODS_PER_DAY - 1);
    }
    // 合并会议名称（跨2行2列）
    for (const m of meetings) {
      mSheet.mergeCells(3, m.col, 4, m.col + 1);
    }
    // 合并 A3:A4
    mSheet.mergeCells(3, 1, 4, 1);
    // 样式
    for (const r of [1, 2]) {
      mSheet.getRow(r).eachCell({ includeEmpty: true }, cell => {
        cell.font = { ...HEADER_FONT };
        cell.fill = { ...HEADER_FILL };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    }
    mSheet.getRow(2).height = 35;
    mSheet.getRow(3).eachCell({ includeEmpty: true }, cell => {
      if (cell.value) {
        cell.font = { bold: true };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
    });
    mSheet.getColumn(1).width = 8;

    // 5教师调休
    const lSheet = wb.addWorksheet('5教师调休');
    lSheet.addRow(['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
    lSheet.addRow(['', '', '', '刘婷', '樊启云', '周晓黎', '']);
    lSheet.addRow(['', '', '', '周晓明', '汤秋风', '唐思莲', '']);
    lSheet.addRow(['', '', '', '唐韵琪', '蒋杨洋', '姚绍兰', '']);
    lSheet.addRow(['', '', '', '张毅', '高波', '孙启军', '']);
    lSheet.getRow(1).eachCell(cell => {
      cell.font = { ...HEADER_FONT };
      cell.fill = { ...HEADER_FILL };
      cell.alignment = { horizontal: 'center' };
    });
    lSheet.columns.forEach(col => { col.width = 12; });

    // 6作息时间（空表）
    wb.addWorksheet('6作息时间');

    // 7调课记录
    const rSheet = wb.addWorksheet('7调课记录');
    // 第1行：序号 | 单双周 | 调出 | 调入 | 变动日期
    rSheet.addRow(['序号', '单双周', '调出', null, null, null, '调入', null, null, null, '变动日期']);
    // 第2行：子表头
    rSheet.addRow([null, null, '班级', '节次', '科目', '教师', '班级', '节次', '科目', '教师', null]);
    // 合并单元格
    rSheet.mergeCells('A1:A2'); // 序号
    rSheet.mergeCells('B1:B2'); // 单双周
    rSheet.mergeCells('C1:F1'); // 调出
    rSheet.mergeCells('G1:J1'); // 调入
    rSheet.mergeCells('K1:K2'); // 变动日期
    // 样式
    for (const r of [1, 2]) {
      rSheet.getRow(r).eachCell({ includeEmpty: true }, cell => {
        cell.font = { ...HEADER_FONT };
        cell.fill = { ...HEADER_FILL };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    }
    rSheet.columns.forEach((col, i) => { col.width = i === 0 ? 8 : 10; });

    const buffer = await wb.xlsx.writeBuffer();
    setDownloadHeader(res, '课表模板.xlsx');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '模板生成失败：' + err.message });
  }
});

// ============ 调课 API ============

// 获取可对调候选课程
app.get('/api/swap/candidates', (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const { className, weekday, period, week } = req.query;
  if (!className || !weekday || !period) return res.status(400).json({ error: '缺少参数' });
  const { entries } = filterByWeek(data, week);
  const weekType = week || (data.weeks || ['通用'])[0];
  const result = computeSwapCandidates(entries, {
    class: className, weekday: Number(weekday), period: Number(period), weekType
  }, weekType, data.meetings, data.teacherMap, data.entries, data.leaves);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// 执行对调（需登录）
app.post('/api/swap/execute', requireLogin, async (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const { source, target, week } = req.body;
  if (!source || !target) return res.status(400).json({ error: '缺少源课程或目标课程' });
  const weekType = week || (data.weeks || ['通用'])[0];
  // 备份当前 entries（用于多步撤销）
  if (!data._undoStack) data._undoStack = [];
  data._undoStack.push({
    weekType,
    entries: JSON.parse(JSON.stringify(data.entries)),
    source: { ...source },
    target: { ...target }
  });
  try {
    executeSwap(data.entries, source, target, weekType, data.meetings, data.teacherMap, false, data.leaves);

    // 高一/高二：同步关联科目到对周 JSON 数据
    // 信息(单周)<->心理(双周)，美术(单周)<->音乐(双周)
    const grade = getGradeLevel(source.class);
    if (grade !== 3 && weekType !== '通用' && data.weeks && data.weeks.length > 1) {
      const otherWeekType = weekType === '单周' ? '双周' : '单周';
      if (data.weeks.includes(otherWeekType)) {
        // 在对周工作表中，同一班级同一时段也需要交换
        const otherSource = { ...source };
        const otherTarget = { ...target };
        executeSwap(data.entries, otherSource, otherTarget, otherWeekType, data.meetings, data.teacherMap, true);
      }
    }

    saveScheduleData(req, data);

    // 自动运行冲突分析
    const conflicts = analyzeConflicts(data.entries || [], data.meetings || [], data.teacherMap || {}, data.leaves || []);

    // 同步修改 Excel 工作簿并追加调课记录
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const sourcePeriodLabel = source.periodLabel || `第${source.period}节`;
    const targetPeriodLabel = target.periodLabel || `第${target.period}节`;
    const record = {
      weekType,
      fromClass: source.class,
      fromPeriod: `${WB_WEEKDAY_NAMES[source.weekday] || ''}${sourcePeriodLabel}`,
      fromSubject: source.subject,
      fromTeacher: source.teacher,
      toClass: target.class,
      toPeriod: `${WB_WEEKDAY_NAMES[target.weekday] || ''}${targetPeriodLabel}`,
      toSubject: target.subject,
      toTeacher: target.teacher,
      changeDate: timestamp
    };
    // 修改 Excel 工作簿中的课程单元格
    const templatePath = scheduleStore.getTemplatePath(getScheduleUserId(req));
    if (fs.existsSync(templatePath)) {
      try {
        await modifyWorkbookOnSwap(templatePath, source, target, weekType);
        await appendSwapRecord(templatePath, record);
      } catch (e) {
        console.error('修改工作簿失败（不影响调课结果）:', e.message);
      }
    }

    // 返回更新后的班级课表和教师参考课表
    const { entries } = filterByWeek(data, weekType);
    const classEntries = entries.filter(e => e.class === source.class);
    const periodLabels = getPeriodLabels(entries);
    const sourceTeacherEntries = getTeacherEntries(entries, source.teacher, weekType);
    const targetTeacher = target.teacher;
    const targetTeacherEntries = targetTeacher ? getTeacherEntries(entries, targetTeacher, weekType) : [];
    res.json({
      ok: true,
      canUndo: (data._undoStack && data._undoStack.length > 0),
      classEntries,
      periodLabels,
      sourceTeacherEntries,
      sourceTeacherName: source.teacher,
      targetTeacherEntries,
      targetTeacherName: target.teacher,
      conflicts
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 撤销对调（需登录）
app.post('/api/swap/undo', requireLogin, async (req, res) => {
  const data = loadData(req);
  if (!data) return res.status(404).json({ error: '无课表数据' });
  if (!data._undoStack || data._undoStack.length === 0) return res.status(400).json({ error: '无可撤销的操作' });
  const weekType = req.body.week || data._undoStack[data._undoStack.length - 1].weekType;
  const backup = data._undoStack.pop();
  // 恢复备份数据
  data.entries = backup.entries;
  if (data._undoStack.length === 0) delete data._undoStack;
  saveScheduleData(req, data);

  // 自动运行冲突分析
  const conflicts = analyzeConflicts(data.entries || [], data.meetings || [], data.teacherMap || {}, data.leaves || []);

  // 恢复 Excel 工作簿：再交换一次 source/target 恢复原始单元格值，并删除最后一条调课记录
  const templatePath = scheduleStore.getTemplatePath(getScheduleUserId(req));
  if (fs.existsSync(templatePath) && backup.source && backup.target) {
    try {
      // 再交换一次恢复 Excel 单元格（modifyWorkbookOnSwap 是对称操作）
      await modifyWorkbookOnSwap(templatePath, backup.source, backup.target, weekType);
      // 高一/高二：对周也需要恢复
      const grade = getGradeLevel(backup.source.class);
      if (grade !== 3 && weekType !== '通用' && data.weeks && data.weeks.length > 1) {
        const otherWeekType = weekType === '单周' ? '双周' : '单周';
        if (data.weeks.includes(otherWeekType)) {
          await modifyWorkbookOnSwap(templatePath, backup.source, backup.target, otherWeekType);
        }
      }
      // 删除最后一条调课记录
      await removeLastSwapRecord(templatePath);
    } catch (e) {
      console.error('恢复工作簿失败（不影响撤销结果）:', e.message);
    }
  }

  const { entries } = filterByWeek(data, weekType);
  const periodLabels = getPeriodLabels(entries);
  res.json({ ok: true, canUndo: (data._undoStack && data._undoStack.length > 0), entries, periodLabels, conflicts });
});

// 获取调课记录
app.get('/api/swap/records', async (req, res) => {
  try {
    const templatePath = scheduleStore.getTemplatePath(getScheduleUserId(req));
    const records = await getSwapRecords(templatePath);
    res.json({ records });
  } catch (err) {
    res.status(500).json({ error: '读取调课记录失败：' + err.message });
  }
});

// 删除当前课表数据（需登录）
app.delete('/api/data', requireLogin, (req, res) => {
  try {
    const userId = getScheduleUserId(req);
    scheduleStore.deleteSchedule(userId);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let lanIP = '';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { lanIP = net.address; break; }
    }
    if (lanIP) break;
  }
  console.log(`课表管理平台已启动:`);
  console.log(`  本机访问: http://localhost:${PORT}`);
  if (lanIP) console.log(`  局域网访问: http://${lanIP}:${PORT}`);
});
