// Excel 工作簿读写工具
// 调课时同步修改上传的课表工作簿，并追加调课记录

const ExcelJS = require('exceljs');
const fs = require('fs');

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周天'];

// 星期文本 -> 数字（与 parser.js 保持一致）
function parseWeekday(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (/^[1-7]$/.test(s)) return Number(s);
  const KW = [
    ['周一', '星期一'], ['周二', '星期二'], ['周三', '星期三'],
    ['周四', '星期四'], ['周五', '星期五'], ['周六', '星期六'],
    ['周天', '周日', '星期日', '星期天']
  ];
  for (let i = 0; i < KW.length; i++) {
    if (KW[i].some(k => s.includes(k))) return i + 1;
  }
  return null;
}

/**
 * 判断年级：使用当前日期动态计算
 * 班级代号前两位 = 入学年份后两位（如 24 = 2024年入学）
 * grade = 当前年份 - 入学年份 + 1
 *   grade==3 → 高三（只改对应周）
 *   grade!=3 → 高一/高二（单双周都改）
 */
function getGradeLevel(classCode) {
  const match = String(classCode).match(/^(\d{2})/);
  if (!match) return null;
  const enrollYear = 2000 + Number(match[1]);
  const currentYear = new Date().getFullYear();
  return currentYear - enrollYear + 1;
}

/**
 * 在工作表中定位指定班级+星期+节次的单元格列号
 * 工作表结构：
 *   Row 1: 标题（合并）
 *   Row 2: 日期行（A2="日期"，之后每 PERIODS_PER_DAY 列为一个星期块）
 *   Row 3: 节次行（A3="节次"，之后为节次标签）
 *   Row 4+: 班级行（A列=班级名）
 * @returns {row, col} 或 null
 */
function findCellPosition(worksheet, className, weekday, periodLabel) {
  // 查找日期行（Row 2）中每个星期块的起始列
  // 注意：合并单元格中每个单元格都可能返回相同的值，需去重连续相同星期
  const dateRow = worksheet.getRow(2);
  const periodRow = worksheet.getRow(3);
  const dayBlocks = []; // { startCol, endCol, weekday }
  let lastWd = null;
  let blockStart = -1;
  for (let c = 2; c <= dateRow.cellCount; c++) {
    const val = dateRow.getCell(c).value;
    if (val == null) {
      // 空单元格可能属于当前块
      continue;
    }
    const wd = parseWeekday(String(val));
    if (wd != null) {
      if (wd !== lastWd) {
        // 新星期块开始
        if (lastWd !== null) {
          dayBlocks.push({ startCol: blockStart, endCol: c - 1, weekday: lastWd });
        }
        lastWd = wd;
        blockStart = c;
      }
    }
  }
  // 最后一个块
  if (lastWd !== null) {
    dayBlocks.push({ startCol: blockStart, endCol: periodRow.cellCount, weekday: lastWd });
  }
  // 找到目标星期块
  const block = dayBlocks.find(b => b.weekday === weekday);
  if (!block) return null;
  // 在该星期块内找到匹配节次标签的列
  let targetCol = -1;
  for (let c = block.startCol; c <= block.endCol; c++) {
    const label = periodRow.getCell(c).value;
    if (label == null) continue;
    const labelStr = String(label).trim();
    if (labelStr === periodLabel || labelStr.includes(periodLabel) || periodLabel.includes(labelStr)) {
      targetCol = c;
      break;
    }
  }
  if (targetCol === -1) return null;
  // 查找班级行（从 Row 4 开始，A 列匹配班级名）
  const totalRows = worksheet.rowCount;
  for (let r = 4; r <= totalRows; r++) {
    const cellA = worksheet.getRow(r).getCell(1).value;
    if (cellA == null) continue;
    const rowClass = String(cellA).trim().replace(/\.0+$/, '');
    // 归一化比较：去除"班"字后缀
    const normRow = rowClass.replace(/班$/, '');
    const normTarget = String(className).replace(/班$/, '').trim();
    if (normRow === normTarget || rowClass === String(className).trim()) {
      return { row: r, col: targetCol };
    }
  }
  return null;
}

// 单双周关联科目映射：单周科目 <-> 双周科目
// 信息(单周) <-> 心理(双周)，美术(单周) <-> 音乐(双周)
const PAIRED_SUBJECTS = {
  '信息': '心理', '心理': '信息',
  '美术': '音乐', '音乐': '美术'
};

/**
 * 修改工作簿：交换两个单元格的科目值
 * 高一/高二调课时，如果涉及信息/心理或美术/音乐，需同步修改对周工作表中关联科目的单元格
 * @param {string} templatePath - 工作簿文件路径
 * @param {Object} source - { class, weekday, period, periodLabel, teacher, subject }
 * @param {Object} target - { class, weekday, period, periodLabel, teacher, subject }
 * @param {string} weekType - '单周' | '双周' | '通用'
 */
async function modifyWorkbookOnSwap(templatePath, source, target, weekType) {
  if (!fs.existsSync(templatePath)) return;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);

  // 判断年级
  const grade = getGradeLevel(source.class);
  const isGrade3 = grade === 3;

  // 确定要修改的工作表
  const sheetNames = wb.worksheets.map(ws => ws.name);
  const sheetsToModify = [];
  if (isGrade3 && weekType !== '通用') {
    // 高三：只修改当前周次对应的工作表
    const targetSheetName = sheetNames.find(n =>
      (weekType === '单周' && /单周/.test(n)) ||
      (weekType === '双周' && /双周/.test(n))
    );
    if (targetSheetName) sheetsToModify.push(targetSheetName);
  } else if (weekType !== '通用') {
    // 高一/高二：只修改当前周次工作表（对周通过关联科目逻辑单独处理）
    const targetSheetName = sheetNames.find(n =>
      (weekType === '单周' && /单周/.test(n)) ||
      (weekType === '双周' && /双周/.test(n))
    );
    if (targetSheetName) sheetsToModify.push(targetSheetName);
  } else {
    // 通用：修改所有总课表工作表
    for (const n of sheetNames) {
      if (/总课表|课表/.test(n) && !/教师/.test(n)) sheetsToModify.push(n);
    }
  }

  // 执行主交换
  for (const sheetName of sheetsToModify) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;
    // 定位源和目标单元格
    const srcPos = findCellPosition(ws, source.class, source.weekday, source.periodLabel || `第${source.period}节`);
    const tgtPos = findCellPosition(ws, target.class, target.weekday, target.periodLabel || `第${target.period}节`);
    if (!srcPos || !tgtPos) continue;
    // 交换两个单元格的值
    const srcCell = ws.getRow(srcPos.row).getCell(srcPos.col);
    const tgtCell = ws.getRow(tgtPos.row).getCell(tgtPos.col);
    const tmp = srcCell.value;
    srcCell.value = tgtCell.value;
    tgtCell.value = tmp;
  }

  // 高一/高二：处理单双周关联科目（信息<->心理，美术<->音乐）
  // 当前周调了信息课，对周对应位置的心理课也要跟着换
  if (!isGrade3 && weekType !== '通用') {
    // 确定对周工作表
    const otherWeekType = weekType === '单周' ? '双周' : '单周';
    const otherSheetName = sheetNames.find(n =>
      (otherWeekType === '单周' && /单周/.test(n)) ||
      (otherWeekType === '双周' && /双周/.test(n))
    );
    if (otherSheetName) {
      const otherWs = wb.getWorksheet(otherSheetName);
      if (otherWs) {
        // 检查源和目标科目是否为关联科目
        // 如果源科目有关联科目（如信息->心理），在对周同一位置也需要交换
        const sourcePaired = PAIRED_SUBJECTS[source.subject];
        const targetPaired = PAIRED_SUBJECTS[target.subject];

        if (sourcePaired || targetPaired) {
          // 在对周工作表中定位对应的单元格并交换
          const otherSrcPos = findCellPosition(otherWs, source.class, source.weekday, source.periodLabel || `第${source.period}节`);
          const otherTgtPos = findCellPosition(otherWs, target.class, target.weekday, target.periodLabel || `第${target.period}节`);
          if (otherSrcPos && otherTgtPos) {
            const otherSrcCell = otherWs.getRow(otherSrcPos.row).getCell(otherSrcPos.col);
            const otherTgtCell = otherWs.getRow(otherTgtPos.row).getCell(otherTgtPos.col);
            const otherTmp = otherSrcCell.value;
            otherSrcCell.value = otherTgtCell.value;
            otherTgtCell.value = otherTmp;
          }
        }
      }
    }
  }

  await wb.xlsx.writeFile(templatePath);
}

/**
 * 确保"7调课记录"工作表存在，如不存在则创建（带表头格式）
 * 10列格式：序号 | 单双周 | 班级 | 调出课程(节次/科目/教师) | 调入课程(节次/科目/教师) | 变动日期
 */
function ensureSwapRecordSheet(wb) {
  const sheetName = wb.worksheets.map(ws => ws.name).find(n => /调课记录/.test(n));
  if (sheetName) return wb.getWorksheet(sheetName);

  // 创建新工作表
  const rSheet = wb.addWorksheet('7调课记录');
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

  // 第1行：序号 | 单双周 | 班级 | 调出课程 | 调入课程 | 变动日期
  rSheet.addRow(['序号', '单双周', '班级', '调出课程', null, null, '调入课程', null, null, '变动日期']);
  // 第2行：子表头
  rSheet.addRow(['序号', '单双周', '班级', '节次', '科目', '教师', '节次', '科目', '教师', '变动日期']);
  // 合并单元格
  rSheet.mergeCells('A1:A2');
  rSheet.mergeCells('B1:B2');
  rSheet.mergeCells('C1:C2');
  rSheet.mergeCells('D1:F1');
  rSheet.mergeCells('G1:I1');
  rSheet.mergeCells('J1:J2');
  // 样式
  for (const r of [1, 2]) {
    rSheet.getRow(r).eachCell({ includeEmpty: true }, cell => {
      cell.font = { ...HEADER_FONT };
      cell.fill = { ...HEADER_FILL };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
  }
  rSheet.columns.forEach((col, i) => { col.width = i === 0 ? 8 : 10; });
  return rSheet;
}

/**
 * 在"7调课记录"工作表中追加一条记录
 * @param {string} templatePath - 工作簿文件路径
 * @param {Object} record - { weekType, fromClass, fromPeriod, fromSubject, fromTeacher, toClass, toPeriod, toSubject, toTeacher, changeDate }
 */
async function appendSwapRecord(templatePath, record) {
  if (!fs.existsSync(templatePath)) return;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);

  const rSheet = ensureSwapRecordSheet(wb);

  // 查找已有数据的最后一行，获取最大序号
  let maxSeq = 0;
  let lastDataRow = 2; // 表头占2行
  const totalRows = rSheet.rowCount;
  for (let r = 3; r <= totalRows; r++) {
    const seqVal = rSheet.getRow(r).getCell(1).value;
    if (seqVal != null && seqVal !== '') {
      const seqNum = Number(seqVal);
      if (!isNaN(seqNum) && seqNum > maxSeq) maxSeq = seqNum;
      lastDataRow = r;
    }
  }

  // 在下一行写入记录（10列格式：班级共用）
  const newRow = lastDataRow + 1;
  const row = rSheet.getRow(newRow);
  row.getCell(1).value = maxSeq + 1;
  row.getCell(2).value = record.weekType || '';
  row.getCell(3).value = record.fromClass || '';
  row.getCell(4).value = record.fromPeriod || '';
  row.getCell(5).value = record.fromSubject || '';
  row.getCell(6).value = record.fromTeacher || '';
  row.getCell(7).value = record.toPeriod || '';
  row.getCell(8).value = record.toSubject || '';
  row.getCell(9).value = record.toTeacher || '';
  row.getCell(10).value = record.changeDate || '';
  row.commit();

  await wb.xlsx.writeFile(templatePath);
}

/**
 * 读取"7调课记录"工作表中已有记录
 * @param {string} templatePath - 工作簿文件路径
 * @returns {Array} 调课记录数组
 */
async function getSwapRecords(templatePath) {
  if (!fs.existsSync(templatePath)) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);

  const sheetName = wb.worksheets.map(ws => ws.name).find(n => /调课记录/.test(n));
  if (!sheetName) return [];
  const rSheet = wb.getWorksheet(sheetName);

  const records = [];
  const totalRows = rSheet.rowCount;
  for (let r = 3; r <= totalRows; r++) {
    const row = rSheet.getRow(r);
    const seq = row.getCell(1).value;
    if (seq == null || seq === '') continue;
    // 10列格式：班级共用（Col 3），调出(Col 4-6)，调入(Col 7-9)，变动日期(Col 10)
    const classVal = String(row.getCell(3).value || '').trim();
    const record = {
      seq: Number(seq) || seq,
      weekType: String(row.getCell(2).value || '').trim(),
      fromClass: classVal,
      fromPeriod: String(row.getCell(4).value || '').trim(),
      fromSubject: String(row.getCell(5).value || '').trim(),
      fromTeacher: String(row.getCell(6).value || '').trim(),
      toClass: classVal,
      toPeriod: String(row.getCell(7).value || '').trim(),
      toSubject: String(row.getCell(8).value || '').trim(),
      toTeacher: String(row.getCell(9).value || '').trim(),
      changeDate: String(row.getCell(10).value || '').trim()
    };
    if (!record.fromClass && !record.toClass) continue;
    records.push(record);
  }
  return records;
}

/**
 * 删除"7调课记录"工作表中最后一条记录（用于撤销调课）
 * @param {string} templatePath - 工作簿文件路径
 */
async function removeLastSwapRecord(templatePath) {
  if (!fs.existsSync(templatePath)) return;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);

  const sheetName = wb.worksheets.map(ws => ws.name).find(n => /调课记录/.test(n));
  if (!sheetName) return;
  const rSheet = wb.getWorksheet(sheetName);

  // 查找最后一行有数据的行（表头占2行，从第3行开始）
  let lastDataRow = -1;
  const totalRows = rSheet.rowCount;
  for (let r = 3; r <= totalRows; r++) {
    const seqVal = rSheet.getRow(r).getCell(1).value;
    if (seqVal != null && seqVal !== '') {
      lastDataRow = r;
    }
  }

  // 删除最后一行记录
  if (lastDataRow >= 3) {
    const row = rSheet.getRow(lastDataRow);
    for (let c = 1; c <= 10; c++) {
      row.getCell(c).value = null;
    }
    row.commit();
    await wb.xlsx.writeFile(templatePath);
  }
}

module.exports = {
  getGradeLevel,
  findCellPosition,
  modifyWorkbookOnSwap,
  appendSwapRecord,
  getSwapRecords,
  removeLastSwapRecord,
  WEEKDAY_NAMES
};
