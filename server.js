const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

const { parseWorkbook } = require('./utils/parser');
const { analyzeConflicts, getStats } = require('./utils/analyzer');
const { teacherStatistics, classStatistics } = require('./utils/statistics');
const {
  exportClassSchedules, exportTeacherSchedules,
  exportSingleClass, exportSingleTeacher, exportTeacherStatistics
} = require('./utils/exporter');
const {
  computeSwapCandidates, executeSwap, getTeacherEntries, getPeriodLabels
} = require('./utils/swap');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'schedule.json');

app.use(express.json());
// 开发期间禁用静态文件缓存，确保每次都加载最新版本
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
// 静态资源不缓存，确保前端修改后刷新即可生效
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

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `upload_${Date.now()}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    if (/xlsx|xls|csv/.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('仅支持 .xlsx / .xls / .csv 文件'));
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

// 读取/保存课表数据
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return null;
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 按周次过滤课表数据，返回该周的条目与所用周次
function filterByWeek(data, week) {
  if (!data) return { entries: [], week: null, weeks: [] };
  const weeks = data.weeks || ['通用'];
  const w = (week && weeks.includes(week)) ? week : weeks[0];
  const entries = data.entries.filter(e => (e.weekType || '通用') === w);
  return { entries, week: w, weeks };
}

// ============ API ============

// 上传并解析总课表
const TEMPLATE_FILE = path.join(UPLOAD_DIR, 'template.xlsx');

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  try {
    const { entries, sheets, weeks, teacherMap, meetings, leaves } = parseWorkbook(req.file.path);
    if (!entries.length) {
      return res.status(400).json({ error: '未能从文件中解析出课表数据，请检查文件格式。需要包含「总课表」和「教师安排」工作表。' });
    }
    const stats = getStats(entries);
    const data = {
      uploadedAt: new Date().toISOString(),
      filename: req.file.originalname,
      sheets,
      entries,
      stats,
      weeks: weeks || ['通用'],
      teacherMap: teacherMap || {},
      meetings: meetings || [],
      leaves: leaves || []
    };
    saveData(data);
    // 保存上传的文件作为模板（覆盖旧的）
    fs.copyFileSync(req.file.path, TEMPLATE_FILE);
    res.json({ ok: true, ...stats, sheets, weeks: data.weeks, meetings: data.meetings || [], leaves: data.leaves || [] });
  } catch (err) {
    res.status(500).json({ error: '解析失败：' + err.message });
  } finally {
    // 清理上传临时文件
    fs.unlink(req.file.path, () => {});
  }
});

// 获取可用周次
app.get('/api/weeks', (req, res) => {
  const data = loadData();
  if (!data) return res.json({ weeks: [] });
  res.json({ weeks: data.weeks || ['通用'] });
});

// 获取概览信息（按周次过滤）
app.get('/api/overview', (req, res) => {
  const data = loadData();
  if (!data) return res.json({ hasData: false, weeks: [] });
  const { entries, week, weeks } = filterByWeek(data, req.query.week);
  const stats = getStats(entries);
  res.json({ hasData: true, ...stats, uploadedAt: data.uploadedAt, filename: data.filename, weeks, week });
});

// 获取所有班级列表
app.get('/api/classes', (req, res) => {
  const data = loadData();
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
  const data = loadData();
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
  const data = loadData();
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
  res.json({ class: className, entries: filtered, count: filtered.length, teacherConfig, periodLabels });
});

// 获取教师课表
app.get('/api/teacher/:teacherName', (req, res) => {
  const data = loadData();
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
  res.json({ teacher: teacherName, entries: filtered, count: filtered.length, periodLabels, meetingConflicts, teacherMeetings, leaveConflictKeys: [...leaveConflictKeys], conflicts });
});

// 教师课时统计
app.get('/api/statistics/teachers', (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const { entries } = filterByWeek(data, req.query.week);
  const stats = teacherStatistics(entries);
  res.json({ teachers: stats });
});

// 班级课时统计
app.get('/api/statistics/classes', (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const { entries } = filterByWeek(data, req.query.week);
  const stats = classStatistics(entries);
  res.json({ classes: stats });
});

// 课表冲突分析
app.get('/api/analysis', (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: '无课表数据' });
  // 冲突分析同时检测单周和双周，不过滤周次
  const result = analyzeConflicts(data.entries || [], data.meetings || [], data.teacherMap || {}, data.leaves || []);
  res.json(result);
});

// 导出所有班级课表
app.get('/api/export/classes', async (req, res) => {
  const data = loadData();
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
  const data = loadData();
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

// 导出单个班级课表
app.get('/api/export/class/:className', async (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const className = decodeURIComponent(req.params.className);
    const { entries, week } = filterByWeek(data, req.query.week);
    const globalPeriodLabels = getPeriodLabels(entries);
    const buffer = await exportSingleClass(entries, className, data.teacherMap, globalPeriodLabels);
    setDownloadHeader(res, `${className}课表-${week}.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 导出单个教师课表
app.get('/api/export/teacher/:teacherName', async (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const teacherName = decodeURIComponent(req.params.teacherName);
    const { entries, week } = filterByWeek(data, req.query.week);
    const globalPeriodLabels = getPeriodLabels(entries);
    const buffer = await exportSingleTeacher(entries, teacherName, data.meetings, data.teacherMap, data.leaves, globalPeriodLabels, week);
    setDownloadHeader(res, `${teacherName}课表-${week}.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 导出教师课时统计
app.get('/api/export/teacher-stats', async (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: '无课表数据' });
  try {
    const { entries, week } = filterByWeek(data, req.query.week);
    const stats = teacherStatistics(entries);
    const buffer = await exportTeacherStatistics(stats);
    setDownloadHeader(res, `教师课时统计-${week}.xlsx`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: '导出失败：' + err.message });
  }
});

// 下载模板：优先使用最近上传的课表文件，没有则生成默认模板
app.get('/api/template', async (req, res) => {
  try {
    // 优先返回上次上传的课表文件
    if (fs.existsSync(TEMPLATE_FILE)) {
      setDownloadHeader(res, '课表模板.xlsx');
      return res.sendFile(TEMPLATE_FILE);
    }
    // 没有上传过则生成默认模板
    const wb = new ExcelJS.Workbook();
    const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周天'];
    const PERIODS = ['早', '1', '2', '3', '4', '5', '6', '7', '8', '晚1', '晚2', '晚3', '晚4'];
    const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '音乐', '美术', '信息', '心理', '体育', '自习', '语文周考', '数学周考', '英语周考'];

    const dateRow = ['日期'];
    const periodRow = ['节次'];
    for (let d = 0; d < DAYS.length; d++) {
      dateRow.push(DAYS[d]);
      for (let p = 0; p < PERIODS.length - 1; p++) dateRow.push(null);
      for (let p = 0; p < PERIODS.length; p++) periodRow.push(PERIODS[p]);
    }

    const sampleClasses = [
      { code: '2401', row: ['语文','数学','英语','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '数学','语文','英语','物理','化学','生物','政治','历史','地理','班会','自习','自习','自习',
        '英语','数学','语文','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '语文','数学','英语','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '数学','语文','英语','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '英语','数学','语文','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '语文','数学','英语','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习'] },
      { code: '2402', row: ['数学','语文','英语','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '语文','数学','英语','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '英语','语文','数学','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '数学','语文','英语','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '语文','数学','英语','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '英语','数学','语文','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习',
        '数学','语文','英语','物理','化学','生物','历史','地理','政治','班会','自习','自习','自习'] }
    ];

    for (const weekType of ['单周', '双周']) {
      const sheet = wb.addWorksheet(`${weekType}总课表`);
      sheet.addRow([weekType]);
      sheet.addRow(dateRow);
      sheet.addRow(periodRow);
      for (const c of sampleClasses) sheet.addRow([c.code, ...c.row]);
      sheet.getRow(1).getCell(1).font = { bold: true, size: 14 };
      for (const r of [2, 3]) {
        sheet.getRow(r).eachCell({ includeEmpty: true }, cell => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
          cell.alignment = { horizontal: 'center' };
        });
      }
      sheet.getColumn(1).width = 10;
    }

    const tSheet = wb.addWorksheet('教师安排');
    tSheet.addRow(['单周']);
    tSheet.addRow(['班级', '班主任', ...SUBJECTS]);
    tSheet.addRow(['2401', '杨老师', '姚老师', '刘老师', '李老师', '姚老师', '杨老师', '周老师', '吴老师', '陈老师', '黄老师', '林老师', '何老师', '肖老师', '张老师', '杨老师', '姚老师', '刘老师', '李老师']);
    tSheet.addRow(['2402', '周老师', '姚老师', '程老师', '唐老师', '姚老师', '杨老师', '周老师', '吴老师', '陈老师', '黄老师', '林老师', '何老师', '肖老师', '张老师', '周老师', '姚老师', '程老师', '唐老师']);
    tSheet.getRow(2).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    });
    tSheet.columns.forEach((col, i) => { col.width = i < 2 ? 10 : 12; });

    const note = wb.addWorksheet('格式说明');
    note.getColumn(1).width = 90;
    const lines = [
      '本平台上传「高中总课表」工作簿，需包含以下工作表：',
      '1.「单周总课表」「双周总课表」（可只含其一）：',
      '   第1行：标题（单周/双周）',
      '   第2行：日期行，第一列填「日期」，其后按周一~周天分块，每个星期名占该块首列',
      '   第3行：节次行，第一列填「节次」，其后每个星期块填时段：早、1、2、3、4、5、6、7、8、晚1、晚2、晚3、晚4',
      '   第4行起：每行一个班级（首列为班级代号，如2401），单元格填该时段的科目',
      '2.「教师安排」表：表头 班级、班主任、各科目列；每行填该班每个科目的任课教师',
      '   平台会据此反查教师：总课表只有科目，教师通过(班级,科目)从本表查出。班会→班主任，自习/社团 不计教师。',
      '说明：',
      '  - 科目种类不限，平台按表头自适应',
      '  - 班级数量不限，增减班级只需在总课表和教师安排表中增减行',
      '  - 时段/星期数量不限，平台按表头自适应',
      '  - 支持 .xlsx / .xls / .csv 格式'
    ];
    lines.forEach(l => note.addRow([l]));

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
  const data = loadData();
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const { className, weekday, period, week } = req.query;
  if (!className || !weekday || !period) return res.status(400).json({ error: '缺少参数' });
  const { entries } = filterByWeek(data, week);
  const weekType = week || (data.weeks || ['通用'])[0];
  const result = computeSwapCandidates(entries, {
    class: className, weekday: Number(weekday), period: Number(period), weekType
  }, weekType, data.meetings, data.teacherMap);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// 执行对调
app.post('/api/swap/execute', (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: '无课表数据' });
  const { source, target, week } = req.body;
  if (!source || !target) return res.status(400).json({ error: '缺少源课程或目标课程' });
  const weekType = week || (data.weeks || ['通用'])[0];
  // 备份当前 entries（用于撤销）
  data._lastBackup = {
    weekType,
    entries: JSON.parse(JSON.stringify(data.entries))
  };
  try {
    executeSwap(data.entries, source, target, weekType, data.meetings, data.teacherMap);
    saveData(data);
    // 返回更新后的班级课表和教师参考课表
    const { entries } = filterByWeek(data, weekType);
    const classEntries = entries.filter(e => e.class === source.class);
    const periodLabels = getPeriodLabels(entries);
    const sourceTeacherEntries = getTeacherEntries(entries, source.teacher, weekType);
    const targetTeacher = target.teacher;
    const targetTeacherEntries = targetTeacher ? getTeacherEntries(entries, targetTeacher, weekType) : [];
    res.json({
      ok: true,
      canUndo: true,
      classEntries,
      periodLabels,
      sourceTeacherEntries,
      sourceTeacherName: source.teacher,
      targetTeacherEntries,
      targetTeacherName: targetTeacher
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 撤销对调
app.post('/api/swap/undo', (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: '无课表数据' });
  if (!data._lastBackup) return res.status(400).json({ error: '无可撤销的操作' });
  const weekType = req.body.week || data._lastBackup.weekType;
  // 恢复备份数据
  data.entries = data._lastBackup.entries;
  delete data._lastBackup;
  saveData(data);
  const { entries } = filterByWeek(data, weekType);
  const periodLabels = getPeriodLabels(entries);
  res.json({ ok: true, canUndo: false, entries, periodLabels });
});

// 删除当前课表数据
app.delete('/api/data', (req, res) => {
  try {
    fs.unlinkSync(DATA_FILE);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.listen(PORT, () => {
  console.log(`课表管理平台已启动: http://localhost:${PORT}`);
});
