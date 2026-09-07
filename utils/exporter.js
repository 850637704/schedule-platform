// 课表导出工具：将班级/教师课表导出为 Excel
const ExcelJS = require('exceljs');

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 将条目列表转为网格（节次 x 星期），返回二维数组 + 最大节次 + 出现的星期 + 节次标签
function entriesToGrid(entries) {
  const grid = new Map(); // period -> Map(weekday -> entry)
  let maxPeriod = 0;
  const weekdays = new Set();
  const periodLabels = new Map(); // period -> label
  for (const e of entries) {
    if (e.period > maxPeriod) maxPeriod = e.period;
    weekdays.add(e.weekday);
    if (!grid.has(e.period)) grid.set(e.period, new Map());
    grid.get(e.period).set(e.weekday, e);
    if (e.periodLabel && !periodLabels.has(e.period)) periodLabels.set(e.period, e.periodLabel);
  }
  return { grid, maxPeriod, weekdays: [...weekdays].sort((a,b)=>a-b), periodLabels };
}

// 单元格内容格式化
function formatEntry(e) {
  if (!e) return '';
  const lines = [];
  if (e.subject) lines.push(e.subject);
  if (e.teacher) lines.push(e.teacher);
  if (e.class) lines.push(e.class);
  if (e.location) lines.push(`@${e.location}`);
  return lines.join('\n');
}

// 导出单个课表（班级或教师）到一个工作表
function addScheduleSheet(wb, title, entries, headerLabels) {
  const sheet = wb.addWorksheet(title);
  const { grid, maxPeriod, weekdays, periodLabels } = entriesToGrid(entries);
  const dayCols = weekdays.length ? weekdays : [1, 2, 3, 4, 5];
  const cols = ['节次', ...dayCols.map(wd => WEEKDAY_NAMES[wd] || `周${wd}`)];
  sheet.addRow(cols);
  // 表头样式
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
  for (let p = 1; p <= maxPeriod; p++) {
    const label = periodLabels.get(p) || `${p}节`;
    const row = [label];
    for (const wd of dayCols) {
      const e = (grid.get(p) || new Map()).get(wd);
      row.push(formatEntry(e));
    }
    sheet.addRow(row);
  }
  // 单元格样式
  for (let r = 2; r <= maxPeriod + 1; r++) {
    sheet.getRow(r).eachCell({ includeEmpty: true }, cell => {
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' }
      };
    });
  }
  sheet.getColumn(1).width = 8;
  for (let i = 2; i <= dayCols.length + 1; i++) sheet.getColumn(i).width = 22;
  return sheet;
}

// 导出班级课表（每个班级一个工作表）
async function exportClassSchedules(entries) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '课表管理平台';
  const classes = [...new Set(entries.map(e => e.class).filter(Boolean))].sort();
  for (const cls of classes) {
    const classEntries = entries.filter(e => e.class === cls);
    const title = cls.length > 28 ? cls.slice(0, 28) : cls;
    addScheduleSheet(wb, title || '未命名班级', classEntries);
  }
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

// 导出教师课表（每个教师一个工作表）
async function exportTeacherSchedules(entries) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '课表管理平台';
  const teachers = [...new Set(entries.map(e => e.teacher).filter(Boolean))].sort();
  for (const t of teachers) {
    const teacherEntries = entries.filter(e => e.teacher === t);
    const title = t.length > 28 ? t.slice(0, 28) : t;
    addScheduleSheet(wb, title || '未命名教师', teacherEntries);
  }
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

// 导出单个班级课表
async function exportSingleClass(entries, className) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '课表管理平台';
  const classEntries = entries.filter(e => e.class === className);
  addScheduleSheet(wb, className, classEntries);
  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

// 导出单个教师课表
async function exportSingleTeacher(entries, teacherName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '课表管理平台';
  const teacherEntries = entries.filter(e => e.teacher === teacherName);
  addScheduleSheet(wb, teacherName, teacherEntries);
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
