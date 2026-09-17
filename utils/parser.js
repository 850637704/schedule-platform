// 课表解析工具
// 主格式：高中总课表（单周/双周 网格 + 教师安排表）
// 兼容旧格式：列表格式 / 简单网格格式
const XLSX = require('xlsx');

const WEEKDAY_KEYS = [
  { kw: ['周一', '星期一'], wd: 1 },
  { kw: ['周二', '星期二'], wd: 2 },
  { kw: ['周三', '星期三'], wd: 3 },
  { kw: ['周四', '星期四'], wd: 4 },
  { kw: ['周五', '星期五'], wd: 5 },
  { kw: ['周六', '星期六'], wd: 6 },
  { kw: ['周天', '周日', '星期日', '星期天'], wd: 7 }
];

// 星期文本 -> 数字
function parseWeekday(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (/^[1-7]$/.test(s)) return Number(s);
  for (const w of WEEKDAY_KEYS) {
    if (w.kw.some(k => s.includes(k))) return w.wd;
  }
  return null;
}

// 中文数字 -> 阿拉伯数字
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1 && CN_NUM[s] != null) return CN_NUM[s];
  if (s.length === 2 && s[0] === '十') return 10 + (CN_NUM[s[1]] || 0);
  if (s.length === 2 && s[1] === '十') return (CN_NUM[s[0]] || 0) * 10;
  if (s.length === 3 && s[1] === '十') return (CN_NUM[s[0]] || 0) * 10 + (CN_NUM[s[2]] || 0);
  return null;
}

// 节次文本 -> 数字（兼容旧格式）
function parsePeriod(text) {
  if (text == null) return null;
  const s = String(text).trim();
  const m = s.match(/第?\s*([零一二三四五六七八九十百\d]+)\s*节/);
  if (m) { const n = cnToNumber(m[1]); if (n != null) return n; }
  if (/^\d+$/.test(s)) return Number(s);
  const cn = cnToNumber(s); if (cn != null) return cn;
  return null;
}

// 班级代号归一化：数字或字符串 -> 去空格的字符串
function normalizeClassCode(v) {
  if (v == null) return '';
  const s = String(v).trim();
  // 纯数字去小数点尾零（Excel 数字 2401 -> "2401"）
  // 统一去除"班"字后缀（总课表"2401班"与教师安排表"2401"归一化）
  return s.replace(/\.0+$/, '').replace(/班$/, '');
}

// ========== 高中总课表格式解析 ==========

// 从「教师安排」表构建 班级 -> { 科目: 教师, _班主任: name }
function buildTeacherMap(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blank: false });
  if (!rows.length) return { teacherMap: {}, subjects: [] };
  // 找表头行（包含"班级"）
  let headerRow = -1;
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    if (rows[r] && String(rows[r][0] || '').includes('班级')) { headerRow = r; break; }
  }
  if (headerRow === -1) return { teacherMap: {}, subjects: [] };
  const headers = rows[headerRow].map((c, i) => ({ val: String(c || '').trim(), idx: i }));
  // 找班主任列与各科目列
  let headTeacherCol = -1;
  const subjectCols = []; // { subject, idx }
  headers.forEach(h => {
    if (/班主任/.test(h.val)) headTeacherCol = h.idx;
    else if (h.val && !['班级', '班主任', '序号', '备注'].includes(h.val) && !/^\s*$/.test(h.val)) {
      subjectCols.push({ subject: h.val, idx: h.idx });
    }
  });
  const teacherMap = {};
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const code = normalizeClassCode(row[0]);
    if (!code || !/^\d/.test(code)) continue; // 班级代号通常以数字开头
    const entry = { _班主任: headTeacherCol >= 0 ? String(row[headTeacherCol] || '').trim() : '' };
    for (const sc of subjectCols) {
      const t = String(row[sc.idx] || '').trim();
      if (t && t !== '-' && t !== '无') entry[sc.subject] = t;
    }
    teacherMap[code] = entry;
  }
  return { teacherMap, subjects: subjectCols.map(s => s.subject) };
}

// 按科目名查找教师（精确 + 模糊）
function findTeacher(teacherEntry, subject) {
  if (!teacherEntry || !subject) return '';
  const s = String(subject).trim();
  if (teacherEntry[s]) return teacherEntry[s];
  // 模糊：科目列名包含 / 被包含
  for (const k of Object.keys(teacherEntry)) {
    if (k === '_班主任') continue;
    if (k.includes(s) || s.includes(k)) return teacherEntry[k];
  }
  return '';
}

// 解析单个总课表工作表（行=班级，列=星期×时段，单元格=科目）
function parseSchoolScheduleSheet(sheet, weekType, teacherMap) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blank: false });
  const entries = [];
  if (!rows.length) return entries;

  // 找"日期"行（含 周一~周天）和"节次"行
  let dateRow = -1, periodRow = -1;
  for (let r = 0; r < Math.min(6, rows.length); r++) {
    const c0 = String(rows[r][0] || '').trim();
    if (c0 === '日期' || c0 === '星期' || /日期|星期/.test(c0)) dateRow = r;
    if (c0 === '节次' || /节次/.test(c0)) periodRow = r;
  }
  // 若没找到日期行，尝试用含"周一"的行
  if (dateRow === -1) {
    for (let r = 0; r < Math.min(6, rows.length); r++) {
      if ((rows[r] || []).some(c => parseWeekday(c) != null)) { dateRow = r; break; }
    }
  }
  if (dateRow === -1 || periodRow === -1) return entries;

  // 日期行：确定每个星期块的起始列
  const blocks = []; // { start, end, weekday }
  const dateCells = rows[dateRow];
  const periodCells = rows[periodRow];
  for (let c = 1; c < dateCells.length; c++) {
    const wd = parseWeekday(dateCells[c]);
    if (wd != null) blocks.push({ start: c, weekday: wd });
  }
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].end = (i + 1 < blocks.length) ? blocks[i + 1].start - 1 : (periodCells.length - 1);
  }
  blocks.forEach(b => {
    b.periods = []; // { col, period, label }
    let pidx = 0;
    for (let c = b.start; c <= b.end; c++) {
      const label = String(periodCells[c] || '').trim();
      if (!label || label === 'null') continue;
      pidx++;
      b.periods.push({ col: c, period: pidx, label });
    }
  });

  // 班级行：节次行之后的行，首列为班级代号
  for (let r = periodRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    // 原始班级名（保留"班"字后缀，用于显示）
    const rawCode = String(row[0] || '').trim().replace(/\.0+$/, '');
    // 归一化班级名（去除"班"字，用于查找 teacherMap）
    const code = normalizeClassCode(row[0]);
    if (!code || !/^\d/.test(code)) continue; // 跳过非班级行
    const teacherEntry = teacherMap[code] || {};
    const headTeacher = teacherEntry._班主任 || '';
    for (const b of blocks) {
      for (const p of b.periods) {
        const raw = row[p.col];
        const subject = (raw == null) ? '' : String(raw).trim();
        if (!subject || subject === 'null' || subject === '-' || subject === '空') continue;
        // 过滤掉非教学科目：含换行/多行内容（会议、调休名单等）
        if(/[\n\r]/.test(subject)) continue;
        // 过滤调休、会议等非教学时段
        if (/调休|会议|行政会|教研|备课|休息|升旗|活动课/.test(subject)) continue;
        let teacher = '';
        if (/班/.test(subject) && !/班会/.test(subject)) {
          // 含"班"但不是"班会"，按普通科目处理
          teacher = findTeacher(teacherEntry, subject);
        } else if (subject === '班会' || subject === '班') {
          teacher = headTeacher;
        } else if (['自习', '自习课', '晚自习', '早自习'].some(x => subject.includes(x))) {
          teacher = headTeacher; // 自习课由班主任看管
        } else if (['社团', '阅读', '活动', '升旗', '休息', '假'].some(x => subject.includes(x))) {
          teacher = ''; // 非教学时段
        } else {
          teacher = findTeacher(teacherEntry, subject);
        }
        entries.push({
          class: rawCode,
          teacher,
          subject,
          weekday: b.weekday,
          period: p.period,
          periodLabel: p.label,
          weekType,
          location: ''
        });
      }
    }
  }
  return entries;
}

// 会议名称 -> 关联科目列表（用于会议冲突检测）
const MEETING_SUBJECT_MAP = {
  '班主任会': ['_班主任'],  // 特殊标记：班主任会关联所有班主任
  '语文组会': ['语文'],
  '数学组会': ['数学'],
  '英语组会': ['英语'],
  '理综组会': ['物理', '化学', '生物'],
  '文综组会': ['历史', '地理', '政治'],
  '艺体组会': ['音乐', '美术', '体育', '信息', '心理'],
  '行政会': ['_班主任'],
};

// 解析「会议时间」工作表
// 结构：第1行=星期行（周一~周天），第2行=节次行，第3行=会议名称行
// 会议使用合并单元格，可能跨多节（如班主任会占第3、4节）
function parseMeetingSheet(sheet) {
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blank: false });
  if (rows.length < 3) return [];
  const dateCells = rows[0] || [];
  const periodCells = rows[1] || [];
  const meetingCells = rows[2] || [];
  // 识别星期块
  const blocks = [];
  for (let c = 1; c < dateCells.length; c++) {
    const wd = parseWeekday(dateCells[c]);
    if (wd != null) blocks.push({ start: c, weekday: wd });
  }
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].end = (i + 1 < blocks.length) ? blocks[i + 1].start - 1 : (periodCells.length - 1);
  }
  // 建立列号 -> 节次标签 映射
  const colToLabel = {};
  for (const b of blocks) {
    for (let c = b.start; c <= b.end; c++) {
      const label = String(periodCells[c] || '').trim();
      if (label && label !== 'null') colToLabel[c] = label;
    }
  }
  // 获取合并单元格信息（会议行 r=2）
  const merges = (sheet['!merges'] || []).filter(m => m.s.r === 2);
  // 查找列 c 所属的合并范围
  function getMergeRange(c) {
    for (const m of merges) {
      if (c >= m.s.c && c <= m.e.c) return { start: m.s.c, end: m.e.c };
    }
    return { start: c, end: c };
  }
  // 遍历会议行，提取每个有会议名称的单元格
  const meetings = [];
  const seenCells = new Set();  // 跳过已处理的合并单元格
  for (let c = 1; c < meetingCells.length; c++) {
    if (seenCells.has(c)) continue;
    const name = String(meetingCells[c] || '').replace(/[\r\n]/g, '').trim();
    if (!name) continue;
    // 找该列所属的星期块
    let weekday = null;
    for (const b of blocks) {
      if (c >= b.start && c <= b.end) { weekday = b.weekday; break; }
    }
    if (weekday == null) continue;
    // 检查合并单元格，获取所有覆盖的节次
    const range = getMergeRange(c);
    const periodLabels = [];
    for (let cc = range.start; cc <= range.end; cc++) {
      seenCells.add(cc);
      const label = colToLabel[cc];
      if (label) periodLabels.push(label);
    }
    if (!periodLabels.length) continue;
    // 每个节次生成一个会议条目（便于冲突检测）
    for (const label of periodLabels) {
      meetings.push({ name, weekday, periodLabel: label });
    }
  }
  return meetings;
}

// 解析「教师调休」工作表
// 调休仅在单周有效。支持三种格式：
//   格式A（列格式）：表头为周一~周日，单元格内为教师姓名（教师在哪列即周几调休）
//   格式B（网格格式）：第1列为教师名，表头为周一~周日，单元格内为调休标记（休/调休/1/✓等）
//   格式C（列表格式）：两列（教师、调休日），调休日为星期文本
// 返回：[{ teacher, weekday }]
function parseLeaveSheet(sheet) {
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blank: false });
  if (!rows.length) return [];

  const leaves = [];
  const seen = new Set(); // 去重 teacher|weekday

  // 在前5行中查找表头行（包含星期名的行）
  let headerIdx = -1;
  let weekdayCols = []; // { col, weekday }
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r] || [];
    const cols = [];
    row.forEach((cell, c) => {
      const wd = parseWeekday(cell);
      if (wd != null) cols.push({ col: c, weekday: wd });
    });
    if (cols.length >= 2) {
      headerIdx = r;
      weekdayCols = cols;
      break;
    }
  }

  if (headerIdx >= 0 && weekdayCols.length > 0) {
    // 判断是格式A（单元格为教师姓名）还是格式B（第一列为教师名，单元格为标记）
    // 取第一个数据行，检查第一列是否为教师名（非空且非星期）
    const firstDataRow = rows[headerIdx + 1] || [];
    const firstCell = String(firstDataRow[0] || '').trim();
    const firstCellIsWeekday = parseWeekday(firstCell) != null;
    // 格式A：第一列为空或为星期名（无教师名列），单元格直接是教师名
    // 格式B：第一列为教师名
    const isColFormat = !firstCell || firstCellIsWeekday || /[周一二三四五六日天]/.test(firstCell);

    if (isColFormat) {
      // 格式A：单元格内的值即为教师姓名
      for (let r = headerIdx + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        for (const { col, weekday } of weekdayCols) {
          const val = row[col];
          if (val == null) continue;
          const teacher = String(val).trim();
          if (!teacher) continue;
          // 跳过可能的标记值（如"休"等单字标记，教师名一般是2-4字中文）
          if (/^(休|调休|休息|1|✓|√|是|有|无|空|-)$/.test(teacher)) continue;
          const key = `${teacher}|${weekday}`;
          if (!seen.has(key)) {
            seen.add(key);
            leaves.push({ teacher, weekday });
          }
        }
      }
    } else {
      // 格式B：第一列为教师名，单元格为标记
      const LEAVE_MARKERS = ['休', '调休', '休息', '1', '✓', '√', '是', '有'];
      const isLeaveMarker = (v) => {
        if (v == null) return false;
        const s = String(v).trim();
        if (!s) return false;
        return LEAVE_MARKERS.some(m => s === m || s.includes(m));
      };
      for (let r = headerIdx + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        const teacher = String(row[0] || '').trim();
        if (!teacher) continue;
        for (const { col, weekday } of weekdayCols) {
          if (isLeaveMarker(row[col])) {
            const key = `${teacher}|${weekday}`;
            if (!seen.has(key)) {
              seen.add(key);
              leaves.push({ teacher, weekday });
            }
          }
        }
      }
    }
  } else {
    // 格式C：列表格式（教师列 + 调休日列）
    let teacherCol = -1, dayCol = -1;
    const headerRow = rows[0] || [];
    headerRow.forEach((cell, c) => {
      const s = String(cell || '').trim();
      if (/教师|老师|姓名/.test(s) && teacherCol === -1) teacherCol = c;
      else if (/调休|休息|星期|周[一二三四五六日天]/.test(s) && dayCol === -1) dayCol = c;
    });
    if (teacherCol === -1) teacherCol = 0;
    if (dayCol === -1) dayCol = 1;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const teacher = String(row[teacherCol] || '').trim();
      const dayText = String(row[dayCol] || '').trim();
      if (!teacher || !dayText) continue;
      const wd = parseWeekday(dayText);
      if (wd != null) {
        const key = `${teacher}|${wd}`;
        if (!seen.has(key)) {
          seen.add(key);
          leaves.push({ teacher, weekday: wd });
        }
      }
    }
  }

  return leaves;
}

// 解析「7调课记录」工作表
// 表头结构（2行）：
//   Row 1: 序号 | 单双周 | 调出(合并C1:F1) | 调入(合并G1:J1) | 变动日期
//   Row 2:      |        | 班级 | 节次 | 科目 | 教师 | 班级 | 节次 | 科目 | 教师 |
//   Row 3+: 数据行
// 返回：[{ seq, weekType, fromClass, fromPeriod, fromSubject, fromTeacher, toClass, toPeriod, toSubject, toTeacher, changeDate }]
function parseSwapRecordSheet(sheet) {
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blank: false });
  if (rows.length < 3) return [];
  // 查找表头行（包含"序号"）
  let headerRow = -1;
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    if (rows[r] && String(rows[r][0] || '').includes('序号')) { headerRow = r; break; }
  }
  if (headerRow === -1) return [];
  // 数据行从 headerRow + 2 开始（表头占2行）
  const records = [];
  for (let r = headerRow + 2; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const seq = row[0];
    if (seq == null || seq === '') continue;
    records.push({
      seq: Number(seq) || seq,
      weekType: String(row[1] || '').trim(),
      fromClass: String(row[2] || '').trim(),
      fromPeriod: String(row[3] || '').trim(),
      fromSubject: String(row[4] || '').trim(),
      fromTeacher: String(row[5] || '').trim(),
      toClass: String(row[6] || '').trim(),
      toPeriod: String(row[7] || '').trim(),
      toSubject: String(row[8] || '').trim(),
      toTeacher: String(row[9] || '').trim(),
      changeDate: String(row[10] || '').trim()
    });
  }
  return records;
}

// 判断是否为高中总课表格式（含 总课表 + 教师安排 工作表）
function isSchoolWorkbook(wb) {
  const names = wb.SheetNames;
  return names.some(n => /教师安排/.test(n)) &&
         names.some(n => /总课表|课表/.test(n));
}

// 解析高中总课表格式
function parseSchoolFormat(wb) {
  const names = wb.SheetNames;
  // 教师安排表（精确匹配"教师安排"，避免误选"教师调休"）
  const teacherSheetName = names.find(n => /教师安排/.test(n)) || names.find(n => /教师/.test(n) && !/调休/.test(n));
  const { teacherMap, subjects: teacherSubjects } = buildTeacherMap(wb.Sheets[teacherSheetName]);
  // 总课表工作表（排除教师相关表）
  const scheduleSheetNames = names.filter(n => /总课表|课表/.test(n) && !/教师/.test(n));
  const allEntries = [];
  const weeks = [];
  const sheetsInfo = [];
  for (const name of scheduleSheetNames) {
    // 周类型：单周/双周
    let weekType = '单周';
    if (/双周/.test(name)) weekType = '双周';
    else if (/单周/.test(name)) weekType = '单周';
    else {
      // 从首行标题判断
      const r0 = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blank: false })[0];
      const t = r0 ? String(r0[0] || '') : '';
      if (/双周/.test(t)) weekType = '双周';
    }
    const entries = parseSchoolScheduleSheet(wb.Sheets[name], weekType, teacherMap);
    if (entries.length) {
      if (!weeks.includes(weekType)) weeks.push(weekType);
      sheetsInfo.push({ name, format: 'school-' + weekType, count: entries.length });
      allEntries.push(...entries);
    }
  }
  // 教师安排信息也记录
  sheetsInfo.push({ name: teacherSheetName, format: 'teacher-map', count: Object.keys(teacherMap).length });
  // 解析「会议时间」工作表
  const meetingSheetName = names.find(n => /会议/.test(n));
  const meetings = meetingSheetName ? parseMeetingSheet(wb.Sheets[meetingSheetName]) : [];
  if (meetings.length) {
    sheetsInfo.push({ name: meetingSheetName, format: 'meetings', count: meetings.length });
  }
  // 解析「教师调休」工作表
  const leaveSheetName = names.find(n => /调休/.test(n));
  const leaves = leaveSheetName ? parseLeaveSheet(wb.Sheets[leaveSheetName]) : [];
  if (leaves.length) {
    sheetsInfo.push({ name: leaveSheetName, format: 'leaves', count: leaves.length });
  }
  // 解析「7调课记录」工作表
  const swapRecordSheetName = names.find(n => /调课记录/.test(n));
  const swapRecords = swapRecordSheetName ? parseSwapRecordSheet(wb.Sheets[swapRecordSheetName]) : [];
  if (swapRecords.length) {
    sheetsInfo.push({ name: swapRecordSheetName, format: 'swap-records', count: swapRecords.length });
  }
  // 解析「8作息时间」工作表（优先"8作息时间表"，排除空表）
  const schedule8Candidates = names.filter(n => /作息时间/.test(n));
  let schedule8 = {};
  let schedule8SheetName = null;
  for (const n of schedule8Candidates) {
    const parsed = parseSchedule8Sheet(wb.Sheets[n]);
    if (Object.keys(parsed).length) {
      schedule8 = parsed;
      schedule8SheetName = n;
      break;
    }
  }
  if (schedule8SheetName) {
    sheetsInfo.push({ name: schedule8SheetName, format: 'schedule8', count: Object.keys(schedule8).length });
  }
  return { entries: allEntries, sheets: sheetsInfo, weeks, teacherSubjects, teacherMap, meetings, leaves, swapRecords, schedule8 };
}

// ========== 旧格式兼容（列表 / 简单网格） ==========

function parseCellContent(cell, fallbackClass) {
  if (cell == null) return null;
  const raw = String(cell).trim();
  if (!raw || raw === '-' || raw === '空') return null;
  let parts = raw.split(/[\n\r]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    const m = raw.match(/^(.+?)\s*[（(]\s*(.+?)\s*[）)]\s*$/);
    if (m) parts = [m[1], m[2]];
    else parts = raw.split(/\s+/).filter(Boolean);
  }
  const entry = { subject: '', teacher: '', class: fallbackClass || '', location: '' };
  parts.forEach(p => {
    if (/班|年级|届/.test(p)) entry.class = entry.class || p;
    else if (!entry.subject) entry.subject = p;
    else if (!entry.teacher) entry.teacher = p;
    else entry.teacher = entry.teacher + ' ' + p;
  });
  if (!entry.subject && parts.length) entry.subject = parts[0];
  return entry;
}

function detectListHeader(rows) {
  if (!rows.length) return null;
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r];
    const map = {};
    row.forEach((cell, c) => {
      const s = String(cell || '').trim();
      if (map.weeks === undefined && /周次/.test(s)) map.weeks = c;
      else if (map.class === undefined && /班级/.test(s)) map.class = c;
      else if (map.teacher === undefined && /教师|老师|任课/.test(s)) map.teacher = c;
      else if (map.subject === undefined && /科目|课程|学科|课目/.test(s)) map.subject = c;
      else if (map.weekday === undefined && /星期|周几|周[一二三四五六日天1-7]/.test(s)) map.weekday = c;
      else if (map.period === undefined && /节次|课时|第.*节|^\d+节?$/.test(s)) map.period = c;
      else if (map.location === undefined && /教室|地点/.test(s)) map.location = c;
    });
    if (map.weekday !== undefined && map.period !== undefined &&
        (map.class !== undefined || map.teacher !== undefined || map.subject !== undefined)) {
      return { headerRow: r, map };
    }
  }
  return null;
}

function parseListSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blank: false });
  const detected = detectListHeader(rows);
  if (!detected) return null;
  const { headerRow, map } = detected;
  const entries = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => c == null || String(c).trim() === '')) continue;
    const weekday = parseWeekday(row[map.weekday]);
    const period = parsePeriod(row[map.period]);
    if (weekday == null || period == null) continue;
    const entry = {
      class: map.class !== undefined ? String(row[map.class] || '').trim() : '',
      teacher: map.teacher !== undefined ? String(row[map.teacher] || '').trim() : '',
      subject: map.subject !== undefined ? String(row[map.subject] || '').trim() : '',
      weekday, period, periodLabel: String(period),
      weekType: '通用', location: map.location !== undefined ? String(row[map.location] || '').trim() : ''
    };
    if (!entry.class && !entry.teacher && !entry.subject) continue;
    entries.push(entry);
  }
  return entries;
}

function parseGridSheet(sheet, sheetName) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blank: false });
  if (!rows.length) return [];
  let headerRow = -1;
  let weekdayCols = {};
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r];
    let foundPeriod = false;
    row.forEach((cell, c) => {
      const s = String(cell || '').trim();
      if (/节次|节/.test(s) && !foundPeriod) foundPeriod = true;
      const wd = parseWeekday(s);
      if (wd) weekdayCols[c] = wd;
    });
    if (foundPeriod && Object.keys(weekdayCols).length) { headerRow = r; break; }
    weekdayCols = {};
  }
  if (headerRow === -1) return [];
  const entries = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const period = parsePeriod(row[0]);
    if (period == null) continue;
    for (const [colStr, weekday] of Object.entries(weekdayCols)) {
      const col = Number(colStr);
      const parsed = parseCellContent(row[col], sheetName);
      if (parsed) {
        entries.push({
          class: parsed.class || sheetName || '',
          teacher: parsed.teacher,
          subject: parsed.subject,
          weekday, period, periodLabel: String(period),
          weekType: '通用', location: parsed.location || ''
        });
      }
    }
  }
  return entries;
}

// ========== 主入口 ==========

function parseWorkbook(filePath) {
  const wb = XLSX.readFile(filePath);
  // 优先：高中总课表格式
  if (isSchoolWorkbook(wb)) {
    const result = parseSchoolFormat(wb);
    return result;
  }
  // 兼容：列表 / 网格
  const allEntries = [];
  const sheetsInfo = [];
  wb.SheetNames.forEach(name => {
    const sheet = wb.Sheets[name];
    let entries = parseListSheet(sheet);
    let format = 'list';
    if (!entries) { entries = parseGridSheet(sheet, name); format = 'grid'; }
    if (entries && entries.length) {
      sheetsInfo.push({ name, format, count: entries.length });
      allEntries.push(...entries);
    }
  });
  const seen = new Set();
  const dedup = allEntries.filter(e => {
    const key = `${e.class}|${e.teacher}|${e.subject}|${e.weekday}|${e.period}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { entries: dedup, sheets: sheetsInfo, weeks: ['通用'], swapRecords: [] };
}

// ========== 8作息时间表解析 ==========
// 返回 { '班级名': { '早自习': '6:45-7:10', '第1节': '8:00-8:45', ... } }
function parseSchedule8Sheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blank: false });
  if (!rows.length) return {};
  const headers = rows[0].map(h => String(h || '').trim());
  const result = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const className = String(row[0] || '').trim();
    if (!className) continue;
    const times = {};
    for (let j = 1; j < headers.length && j < row.length; j++) {
      const label = headers[j];
      const val = String(row[j] || '').trim();
      if (val) times[label] = val;
    }
    result[className] = times;
  }
  return result;
}

module.exports = { parseWorkbook, parseWeekday, parsePeriod, parseCellContent, parseMeetingSheet, parseLeaveSheet, parseSwapRecordSheet, parseSchedule8Sheet, MEETING_SUBJECT_MAP, buildTeacherMap };
