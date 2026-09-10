// 课表导出工具：将班级/教师课表导出为 Excel
const ExcelJS = require('exceljs');

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周天'];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]; // 始终显示周一到周日

// 将条目列表转为网格（节次 x 星期），返回二维数组 + 最大节次 + 节次标签
function entriesToGrid(entries) {
  const grid = new Map(); // period -> Map(weekday -> entry[])
  let maxPeriod = 0;
  const periodLabels = new Map(); // period -> label
  for (const e of entries) {
    if (e.period > maxPeriod) maxPeriod = e.period;
    if (!grid.has(e.period)) grid.set(e.period, new Map());
    const dayMap = grid.get(e.period);
    if (!dayMap.has(e.weekday)) dayMap.set(e.weekday, []);
    dayMap.get(e.weekday).push(e);
    if (e.periodLabel && !periodLabels.has(e.period)) periodLabels.set(e.period, e.periodLabel);
  }
  return { grid, maxPeriod, periodLabels };
}

// 教师视图单元格内容：科目 + 班级（多班级用 / 分隔）
function formatTeacherEntry(arr) {
  if (!arr || !arr.length) return '';
  const seen = new Set();
  const unique = [];
  for (const e of arr) {
    const k = `${e.class}|${e.subject}`;
    if (!seen.has(k)) { seen.add(k); unique.push(e); }
  }
  const subject = unique[0].subject || '';
  const classes = [...new Set(unique.map(e => e.class).filter(Boolean))];
  const lines = [];
  if (subject) lines.push(subject);
  if (classes.length) lines.push(classes.join(' / '));
  if (unique[0].location) lines.push(`@${unique[0].location}`);
  return lines.join('\n');
}

// 班级视图单元格内容：科目 + 教师
function formatClassEntry(arr) {
  if (!arr || !arr.length) return '';
  const e = arr[0];
  const lines = [];
  if (e.subject) lines.push(e.subject);
  if (e.teacher) lines.push(e.teacher);
  if (e.location) lines.push(`@${e.location}`);
  return lines.join('\n');
}

// 导出单个课表到一个工作表
// mode: 'teacher' | 'class'
// teacherMeetings: [{weekday, period, meetingName}] 教师需参加的会议（仅教师模式）
// globalPeriodLabels: {period: label} 全局节次标签，用于显示完整节次行（即使该教师后几节没课）
// meetingConflictKeys: Set<"weekday|period"> 会议冲突单元格（有课+有会议）
// leaveConflictKeys: Set<"weekday|period"> 调休冲突单元格（调休日被排课）
// teacherConfig: {subject: teacher, _班主任: name} 班级任课教师配置（仅班级模式，显示在课表上方）
function addScheduleSheet(wb, title, entries, mode, teacherMeetings, globalPeriodLabels, meetingConflictKeys, leaveConflictKeys, teacherConfig) {
  const sheet = wb.addWorksheet(title);
  const gridResult = entriesToGrid(entries);
  const { grid, periodLabels } = gridResult;
  let maxPeriod = gridResult.maxPeriod;
  // 用全局节次标签补全：保证显示完整节次行（即使该教师/班级后几节没课）
  if (globalPeriodLabels) {
    for (const [p, label] of Object.entries(globalPeriodLabels)) {
      const pn = Number(p);
      if (!periodLabels.has(pn)) periodLabels.set(pn, label);
    }
    const globalMax = Math.max(...Object.keys(globalPeriodLabels).map(Number));
    if (globalMax > maxPeriod) maxPeriod = globalMax;
  }
  const dayCols = ALL_DAYS; // 始终显示周一到周天
  const totalCols = dayCols.length + 1; // 节次列 + 7天
  let currentRow = 1; // 当前行号（1-based）

  // ===== 任课教师表（仅班级模式，显示在课表上方）=====
  let teacherConfigRowCount = 0;
  if (mode === 'class' && teacherConfig && Object.keys(teacherConfig).length) {
    const headTeacher = teacherConfig._班主任 || '';
    const allItems = [];
    if (headTeacher) allItems.push({ subj: '班主任', teacher: headTeacher });
    for (const [subj, teacher] of Object.entries(teacherConfig)) {
      if (subj === '_班主任') continue;
      if (subj === '自习' || subj === '自习课') allItems.push({ subj, teacher: headTeacher || teacher || '' });
      else allItems.push({ subj, teacher: teacher || '' });
    }
    const COLS = 8; // 每行8列，与课表列数一致
    for (let i = 0; i < allItems.length; i += COLS) {
      const chunk = allItems.slice(i, i + COLS);
      // 科目行（蓝底白字）
      const subjRow = [];
      for (const item of chunk) subjRow.push(item.subj || '');
      for (let j = chunk.length; j < COLS; j++) subjRow.push('');
      sheet.addRow(subjRow);
      sheet.getRow(currentRow).eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
        cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      });
      currentRow++;
      // 教师行（浅蓝底）
      const teaRow = [];
      for (const item of chunk) teaRow.push(item.teacher || '');
      for (let j = chunk.length; j < COLS; j++) teaRow.push('');
      sheet.addRow(teaRow);
      sheet.getRow(currentRow).eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FF' } };
        cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      });
      currentRow++;
      teacherConfigRowCount += 2;
    }
  }

  // ===== 课表表头 =====
  const cols = ['节次', ...dayCols.map(wd => WEEKDAY_NAMES[wd] || `周${wd}`)];
  sheet.addRow(cols);
  // 表头样式（蓝色底白字，与页面一致）
  sheet.getRow(currentRow).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });
  const headerRowNum = currentRow;
  currentRow++;
  // 会议时间映射（仅教师模式）
  const meetingMap = new Map();
  if (teacherMeetings) {
    for (const tm of teacherMeetings) {
      meetingMap.set(`${tm.weekday}|${tm.period}`, tm.meetingName);
    }
  }
  // 冲突 key 集合
  const meetingConflictSet = new Set(meetingConflictKeys || []);
  const leaveConflictSet = new Set(leaveConflictKeys || []);
  const fmt = mode === 'teacher' ? formatTeacherEntry : formatClassEntry;
  for (let p = 1; p <= maxPeriod; p++) {
    const label = periodLabels.get(p) || `第${p}节`;
    const row = [label];
    for (const wd of dayCols) {
      const arr = (grid.get(p) || new Map()).get(wd);
      if (arr && arr.length) {
        row.push(fmt(arr));
      } else {
        // 空单元格：教师模式下若有会议显示会议名（水印），否则显示 —
        const mName = mode === 'teacher' ? meetingMap.get(`${wd}|${p}`) : null;
        row.push(mName || '—');
      }
    }
    sheet.addRow(row);
    currentRow++;
  }
  // 课表内容单元格样式（从表头下一行开始到最后一行）
  for (let r = headerRowNum + 1; r < currentRow; r++) {
    const p = r - headerRowNum; // 对应的节次
    sheet.getRow(r).eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' }
      };
      // 第一列（节次列）浅蓝底
      if (colNumber === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
        cell.font = { bold: true, color: { argb: 'FF2F5496' }, size: 10 };
      } else {
        const wd = colNumber - 1; // 星期序号
        const key = `${wd}|${p}`;
        const arr = (grid.get(p) || new Map()).get(wd);
        const hasContent = arr && arr.length;
        // 判断冲突类型（仅教师模式）
        let conflictType = null;
        if (mode === 'teacher' && hasContent) {
          // 重课冲突：同一节课多个班级
          const classSet = new Set(arr.map(e => e.class).filter(Boolean));
          if (classSet.size > 1) conflictType = 'overlap';
          else if (meetingConflictSet.has(key)) conflictType = 'meeting';
          else if (leaveConflictSet.has(key)) conflictType = 'leave';
        }
        if (conflictType === 'overlap') {
          // 重课冲突：浅红底 + 红色边框
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
          cell.border = { top: { style: 'medium', color: { argb: 'FFE74C3C' } }, bottom: { style: 'medium', color: { argb: 'FFE74C3C' } }, left: { style: 'medium', color: { argb: 'FFE74C3C' } }, right: { style: 'medium', color: { argb: 'FFE74C3C' } } };
          cell.font = { size: 10, color: { argb: 'FFE74C3C' }, bold: true };
        } else if (conflictType === 'meeting') {
          // 会议冲突：浅橙底 + 橙色边框
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF5E7' } };
          cell.border = { top: { style: 'medium', color: { argb: 'FFF39C12' } }, bottom: { style: 'medium', color: { argb: 'FFF39C12' } }, left: { style: 'medium', color: { argb: 'FFF39C12' } }, right: { style: 'medium', color: { argb: 'FFF39C12' } } };
          cell.font = { size: 10, color: { argb: 'FFD48806' }, bold: true };
        } else if (conflictType === 'leave') {
          // 调休冲突：浅紫底 + 紫色边框
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4ECFF' } };
          cell.border = { top: { style: 'medium', color: { argb: 'FF8E44AD' } }, bottom: { style: 'medium', color: { argb: 'FF8E44AD' } }, left: { style: 'medium', color: { argb: 'FF8E44AD' } }, right: { style: 'medium', color: { argb: 'FF8E44AD' } } };
          cell.font = { size: 10, color: { argb: 'FF8E44AD' }, bold: true };
        } else if (hasContent) {
          // 有课程内容：浅蓝灰底
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FF' } };
          cell.font = { size: 10 };
        } else {
          // 空单元格
          const mName = mode === 'teacher' ? meetingMap.get(key) : null;
          if (mName) {
            // 会议水印：浅黄底 + 半透明橙色文字
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBE6' } };
            cell.font = { size: 10, color: { argb: 'FFD48806' } };
          } else {
            cell.font = { size: 10, color: { argb: 'FFC0C4CC' } };
          }
        }
      }
    });
  }
  // 列宽
  sheet.getColumn(1).width = 10;
  for (let i = 2; i <= dayCols.length + 1; i++) sheet.getColumn(i).width = 16;
  // 行高
  for (let r = 1; r < currentRow; r++) sheet.getRow(r).height = 32;
  return sheet;
}

// 计算教师需参加的会议时间
function getTeacherMeetings(entries, meetings, teacherMap, teacherName) {
  const { MEETING_SUBJECT_MAP } = require('./parser');
  // 构建 科目 -> 教师集合
  const subjectTeachers = {};
  for (const info of Object.values(teacherMap || {})) {
    for (const [subj, teacher] of Object.entries(info)) {
      if (!subjectTeachers[subj]) subjectTeachers[subj] = new Set();
      if (teacher) subjectTeachers[subj].add(teacher);
    }
  }
  // 该教师参与的会议
  const myMeetings = [];
  for (const meeting of meetings || []) {
    const subjects = MEETING_SUBJECT_MAP[meeting.name] || [];
    for (const subj of subjects) {
      if (subjectTeachers[subj] && subjectTeachers[subj].has(teacherName)) {
        myMeetings.push(meeting);
        break;
      }
    }
  }
  // periodLabel -> period 序号
  const labelToPeriod = {};
  for (const e of entries) {
    if (e.periodLabel && !(e.periodLabel in labelToPeriod)) labelToPeriod[e.periodLabel] = e.period;
  }
  const result = [];
  const seen = new Set();
  for (const m of myMeetings) {
    const p = labelToPeriod[m.periodLabel];
    if (p == null) continue;
    const key = `${m.weekday}|${p}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ weekday: m.weekday, period: p, meetingName: m.name });
    }
  }
  return result;
}

// 计算教师的冲突单元格 key（会议冲突 + 调休冲突）
// 返回 { meetingConflictKeys: Set<string>, leaveConflictKeys: Set<string> }
function getTeacherConflictKeys(entries, meetings, teacherMap, leaves, teacherName, weekType) {
  const teacherEntries = entries.filter(e => e.teacher === teacherName);
  // 会议冲突：教师在会议时间被排课
  const teacherMeetings = getTeacherMeetings(entries, meetings, teacherMap, teacherName);
  const meetingConflictKeys = new Set();
  for (const tm of teacherMeetings) {
    for (const e of teacherEntries) {
      if (e.weekday === tm.weekday && e.period === tm.period) {
        meetingConflictKeys.add(`${e.weekday}|${e.period}`);
      }
    }
  }
  // 调休冲突：调休日被排课（仅单周/通用）
  const leaveConflictKeys = new Set();
  if (leaves && leaves.length && (weekType === '单周' || weekType === '通用' || !weekType)) {
    const myLeaveDays = new Set();
    for (const l of leaves) {
      if (l.teacher === teacherName && l.weekday) myLeaveDays.add(l.weekday);
    }
    for (const e of teacherEntries) {
      if (myLeaveDays.has(e.weekday)) {
        leaveConflictKeys.add(`${e.weekday}|${e.period}`);
      }
    }
  }
  return { meetingConflictKeys, leaveConflictKeys };
}

// 导出班级课表（每个班级一个工作表）
async function exportClassSchedules(entries, teacherMap, globalPeriodLabels) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '课表管理平台';
  const classes = [...new Set(entries.map(e => e.class).filter(Boolean))].sort();
  for (const cls of classes) {
    const classEntries = entries.filter(e => e.class === cls);
    const title = cls.length > 28 ? cls.slice(0, 28) : cls;
    // 从 teacherMap 查找该班级的教师配置（key 为归一化班级名，如 "2401"）
    const normCls = cls.replace(/班$/, '');
    const teacherConfig = (teacherMap && teacherMap[normCls]) || {};
    addScheduleSheet(wb, title || '未命名班级', classEntries, 'class', null, globalPeriodLabels, null, null, teacherConfig);
  }
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

// 导出教师课表（每个教师一个工作表）
async function exportTeacherSchedules(entries, meetings, teacherMap, leaves, globalPeriodLabels, weekType) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '课表管理平台';
  const teachers = [...new Set(entries.map(e => e.teacher).filter(Boolean))].sort();
  for (const t of teachers) {
    const teacherEntries = entries.filter(e => e.teacher === t);
    const teacherMeetings = getTeacherMeetings(entries, meetings, teacherMap, t);
    const { meetingConflictKeys, leaveConflictKeys } = getTeacherConflictKeys(entries, meetings, teacherMap, leaves, t, weekType);
    const title = t.length > 28 ? t.slice(0, 28) : t;
    addScheduleSheet(wb, title || '未命名教师', teacherEntries, 'teacher', teacherMeetings, globalPeriodLabels, meetingConflictKeys, leaveConflictKeys);
  }
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

// 导出单个班级课表
async function exportSingleClass(entries, className, teacherMap, globalPeriodLabels) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '课表管理平台';
  const classEntries = entries.filter(e => e.class === className);
  const normCls = className.replace(/班$/, '');
  const teacherConfig = (teacherMap && teacherMap[normCls]) || {};
  addScheduleSheet(wb, className, classEntries, 'class', null, globalPeriodLabels, null, null, teacherConfig);
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

// 导出单个教师课表
async function exportSingleTeacher(entries, teacherName, meetings, teacherMap, leaves, globalPeriodLabels, weekType) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '课表管理平台';
  const teacherEntries = entries.filter(e => e.teacher === teacherName);
  const teacherMeetings = getTeacherMeetings(entries, meetings, teacherMap, teacherName);
  const { meetingConflictKeys, leaveConflictKeys } = getTeacherConflictKeys(entries, meetings, teacherMap, leaves, teacherName, weekType);
  addScheduleSheet(wb, teacherName, teacherEntries, 'teacher', teacherMeetings, globalPeriodLabels, meetingConflictKeys, leaveConflictKeys);
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

// 导出教师课时统计
async function exportTeacherStatistics(stats) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '课表管理平台';
  const sheet = wb.addWorksheet('教师课时统计');
  sheet.addRow(['教师', '周课时', '月课时(约)', '涉及班级数', '涉及科目数', '班级列表', '科目列表']);
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  for (const s of stats) {
    sheet.addRow([s.teacher, s.weeklyHours, s.monthlyHours, s.classCount, s.subjectCount, s.classes.join('、'), s.subjects.join('、')]);
  }
  for (let i = 1; i <= 7; i++) sheet.getColumn(i).width = i === 1 ? 12 : (i >= 6 ? 30 : 14);
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

module.exports = { exportClassSchedules, exportTeacherSchedules, exportSingleClass, exportSingleTeacher, exportTeacherStatistics };
