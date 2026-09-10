// 课表管理平台前端逻辑
const WEEKDAYS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周天'];
let currentWeek = null;     // 当前周次（单周/双周/通用）
let weeksList = [];         // 可用周次列表
let activeView = 'upload';  // 当前激活的视图
let lastClassSel = '';      // 上次选中的班级
let lastTeacherSel = '';    // 上次选中的教师

// ===== 调课状态 =====
let swapState = {
  mode: 'teacher',         // 'teacher' | 'class'
  teacher: '',             // 当前调课教师
  class: '',               // 当前调课班级
  classList: [],           // 教师任教的班级列表
  source: null,           // 源课程 { class, weekday, period, teacher, subject }
  target: null,           // 目标课程 { class, weekday, period, teacher, subject }
  candidates: [],          // 可对调候选列表
  canUndo: false,         // 是否可撤销
  periodLabels: null      // 全局节次标签
};

// ===== 工具函数 =====
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(() => el.classList.remove('show'), 2800);
}

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return res;
}

// 拼接周次查询参数
function weekParam(prefix = '?') {
  return currentWeek ? `${prefix}week=${encodeURIComponent(currentWeek)}` : '';
}
function exportUrl(base) {
  return base + weekParam('?');
}

// ===== 导航 =====
$$('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    activeView = item.dataset.view;
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    $$('.view').forEach(v => v.classList.remove('active'));
    $('#view-' + activeView).classList.add('active');
    // 把 week-bar 移动到当前视图的 filter-bar 内部第一项
    if (activeView === 'class' || activeView === 'teacher' || activeView === 'swap' || activeView === 'stats') {
      const view = $('#view-' + activeView);
      const filterBar = view.querySelector('.filter-bar');
      const weekBar = $('#week-bar');
      if (filterBar && weekBar) {
        filterBar.prepend(weekBar);
      }
    }
    loadView(activeView);
  });
});

function loadView(view) {
  switch (view) {
    case 'upload': break;
    case 'overview': loadOverview(); break;
    case 'class': loadClassList(); break;
    case 'teacher': loadTeacherList(); break;
    case 'swap': loadSwapView(); break;
    case 'stats': loadStats(); break;
    case 'analysis': break;
  }
}

// ===== 周次选择条 =====
function initWeekBar(weeks, defaultWeek) {
  weeksList = weeks || ['通用'];
  const bar = $('#week-bar');
  const sel = $('#week-select');
  if (weeksList.length > 1) {
    bar.style.display = 'flex';
    sel.innerHTML = weeksList.map(w => `<option value="${escapeAttr(w)}">${escapeHtml(w)}</option>`).join('');
    currentWeek = defaultWeek && weeksList.includes(defaultWeek) ? defaultWeek : weeksList[0];
    sel.value = currentWeek;
    if (!sel.dataset.bound) {
      sel.dataset.bound = 1;
      sel.addEventListener('change', () => {
        currentWeek = sel.value;
        loadView(activeView);
      });
    }
  } else {
    bar.style.display = 'none';
    currentWeek = weeksList[0] || '通用';
  }
}

// ===== 数据状态检查 =====
async function checkData() {
  const data = await api('/api/overview');
  if (data.hasData) {
    $('#data-status').textContent = '✓ 已上传课表';
    $('#data-status').classList.add('active');
    initWeekBar(data.weeks, data.week);
    return true;
  }
  $('#data-status').textContent = '未上传课表';
  $('#data-status').classList.remove('active');
  initWeekBar([], null);
  return false;
}

// ===== 上传 =====
const dropZone = $('#drop-zone');
const fileInput = $('#file-input');

$('#select-btn').addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') fileInput.click();
});
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFile(fileInput.files[0]);
});

async function uploadFile(file) {
  const result = $('#upload-result');
  result.innerHTML = '<div class="alert alert-success">正在上传并解析...</div>';
  const formData = new FormData();
  formData.append('file', file);
  try {
    const data = await api('/api/upload', { method: 'POST', body: formData });
    if (data.error) {
      result.innerHTML = `<div class="alert alert-error">${escapeHtml(data.error)}</div>`;
      return;
    }
    $('#data-status').textContent = '✓ 已上传课表';
    $('#data-status').classList.add('active');
    // 清除之前缓存的选中状态，确保新课表数据不被旧选择污染
    lastTeacherSel = '';
    lastClassSel = '';
    initWeekBar(data.weeks, data.weeks ? data.weeks[0] : null);
    const sheetsInfo = data.sheets.map(s => `${escapeHtml(s.name)}(${s.format}:${s.count})`).join('、');
    result.innerHTML = `
      <div class="alert alert-success">
        ✅ 上传成功！共解析 ${data.totalEntries} 条课表记录<br>
        班级 ${data.classCount} 个 · 教师 ${data.teacherCount} 名 · 科目 ${data.subjectCount} 种<br>
        工作表：${sheetsInfo}
      </div>`;
    toast('上传成功', 'success');
    // 上传成功后自动执行冲突分析
    runAnalysis();
    // 重新加载当前视图，确保展示的是新课表数据
    loadView(activeView);
  } catch (err) {
    result.innerHTML = `<div class="alert alert-error">上传失败：${escapeHtml(err.message)}</div>`;
  }
}

// ===== 总览 =====
async function loadOverview() {
  const data = await api('/api/overview' + weekParam());
  if (!data.hasData) {
    $('#overview-cards').innerHTML = noDataHtml();
    $('#overview-info').innerHTML = '';
    return;
  }
  initWeekBar(data.weeks, data.week || currentWeek);
  $('#overview-cards').innerHTML = `
    ${statCard(data.totalEntries, '课表记录数', 'primary')}
    ${statCard(data.classCount, '班级数', 'success')}
    ${statCard(data.teacherCount, '教师数', 'warning')}
    ${statCard(data.subjectCount, '科目数', 'primary')}
  `;
  $('#overview-info').innerHTML = `
    <p><strong>文件：</strong>${escapeHtml(data.filename)}</p>
    <p><strong>上传时间：</strong>${new Date(data.uploadedAt).toLocaleString('zh-CN')}</p>
    <p style="margin-top:10px"><strong>班级列表：</strong>${data.classes.map(escapeHtml).join('、')}</p>
    <p style="margin-top:6px"><strong>教师列表：</strong>${data.teachers.map(escapeHtml).join('、')}</p>
  `;
}

function statCard(num, label, type = 'primary') {
  return `<div class="stat-card ${type}"><div class="num">${num}</div><div class="label">${label}</div></div>`;
}

function noDataHtml() {
  return `<div class="no-data"><div class="icon">📭</div><p>暂无课表数据，请先上传</p></div>`;
}

// ===== 班级课表 =====
async function loadClassList() {
  const data = await api('/api/classes' + weekParam());
  if (data.error) { $('#class-grid').innerHTML = noDataHtml(); return; }
  // 导出按钮绑定（只绑一次）
  const exportBtn = $('#class-export-btn');
  if (!exportBtn.dataset.bound) {
    exportBtn.dataset.bound = 1;
    exportBtn.addEventListener('click', () => {
      const cur = $('#class-select')._value || '';
      if (cur) window.open(exportUrl(`/api/export/class/${encodeURIComponent(cur)}`), '_blank');
      else toast('请先选择班级', 'error');
    });
  }
  const all = data.classes.slice().sort();
  initCombobox('class-select', all, lastClassSel, (val) => {
    lastClassSel = val;
    if (val) loadClassSchedule(val);
    else { $('#class-teachers').innerHTML = ''; $('#class-grid').innerHTML = ''; }
  }, groupClasses);
  // 如果有上次选中，立即触发一次渲染（即使该班级本周无课，也要重新加载以清除旧数据）
  if (lastClassSel) {
    loadClassSchedule(lastClassSel);
  } else {
    $('#class-teachers').innerHTML = '';
    $('#class-grid').innerHTML = '';
  }
}

async function loadClassSchedule(className) {
  const data = await api(`/api/class/${encodeURIComponent(className)}` + weekParam());
  if (data.error) { toast(data.error, 'error'); return; }
  // 渲染教师配置表
  renderTeacherConfig(className, data.teacherConfig);
  // 渲染课表网格（使用全局节次标签）
  $('#class-grid').innerHTML = renderScheduleGrid(data.entries, 'class', data.periodLabels);
  // 根据视口高度自适应行高
  adjustRowHeight();
}

// 根据浏览器视口高度，动态计算行高，使任课教师表和课表都能完整展示
function adjustRowHeight() {
  const view = document.getElementById('view-class');
  if (!view || !view.classList.contains('active')) return;

  // 视口高度
  const vh = window.innerHeight;

  // 非 table 元素占用的高度：h1 + filter-bar + margins/padding
  const h1 = view.querySelector('h1');
  const filterBar = view.querySelector('.filter-bar');
  const offsetH = (h1 ? h1.offsetHeight : 0) + (filterBar ? filterBar.offsetHeight : 0) + 40;

  // 可用高度
  const availH = vh - offsetH;

  // 统计行数
  const teacherRows = document.querySelectorAll('#class-teachers .teacher-config-table tr').length;
  const scheduleThRows = 1; // 表头行
  const scheduleTdRows = document.querySelectorAll('#class-grid .schedule-grid tbody tr').length;
  const totalRows = teacherRows + scheduleThRows + scheduleTdRows;

  if (totalRows === 0) return;

  // 计算行高，限制最小 18px、最大 60px
  let rowH = Math.floor(availH / totalRows);
  rowH = Math.max(18, Math.min(60, rowH));

  document.documentElement.style.setProperty('--row-h', rowH + 'px');
}

// 窗口大小变化时重新计算（包括浏览器缩放）
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(adjustRowHeight, 100);
});

// 监听视觉视口变化（捕获浏览器缩放）
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(adjustRowHeight, 100);
  });
}

// 渲染班级教师配置表：科目前行（蓝底白字=课表表头th）+ 教师行（浅蓝=课表内容）
// 用两行 tr + border-collapse 合并中间边框，精确匹配课表内容单元格行高36.914px
function renderTeacherConfig(className, config) {
  const wrap = $('#class-teachers');
  if (!config || Object.keys(config).length === 0) { wrap.innerHTML = ''; return; }
  const entries = Object.entries(config).filter(([k]) => k !== '_班主任');
  const headTeacher = config._班主任 || '';
  const allItems = [];
  if (headTeacher) allItems.push({ subj: '班主任', teacher: headTeacher });
  for (const [subj, teacher] of entries) {
    if (subj === '自习' || subj === '自习课') allItems.push({ subj, teacher: headTeacher || teacher || '' });
    else allItems.push({ subj, teacher: teacher || '' });
  }
  const COLS = 8; // 每行8个科目
  const colPct = 100 / COLS; // 8列均分 100% 宽
  let cg = '<colgroup>';
  for (let k = 0; k < COLS; k++) cg += `<col style="width:${colPct.toFixed(4)}%">`;
  cg += '</colgroup>';
  let html = '<table class="teacher-config-table">' + cg + '<tbody>';
  for (let i = 0; i < allItems.length; i += COLS) {
    const chunk = allItems.slice(i, i + COLS);
    // 科目行（tr1）
    html += '<tr class="tc-row-subj">';
    for (const item of chunk) html += `<td class="tc-td-subj">${item.subj ? escapeHtml(item.subj) : '&nbsp;'}</td>`;
    for (let j = chunk.length; j < COLS; j++) html += '<td class="tc-td-empty">&nbsp;</td>';
    html += '</tr>';
    // 教师行（tr2）
    html += '<tr class="tc-row-tea">';
    for (const item of chunk) html += `<td class="tc-td-tea">${item.teacher ? escapeHtml(item.teacher) : '&nbsp;'}</td>`;
    for (let j = chunk.length; j < COLS; j++) html += '<td class="tc-td-empty tc-row-tea-empty">&nbsp;</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ===== 教师课表 =====
async function loadTeacherList() {
  const data = await api('/api/teachers' + weekParam());
  if (data.error) { $('#teacher-grid').innerHTML = noDataHtml(); return; }
  // 导出按钮绑定（只绑一次）
  const exportBtn = $('#teacher-export-btn');
  if (!exportBtn.dataset.bound) {
    exportBtn.dataset.bound = 1;
    exportBtn.addEventListener('click', () => {
      const cur = $('#teacher-select')._value || '';
      if (cur) window.open(exportUrl(`/api/export/teacher/${encodeURIComponent(cur)}`), '_blank');
      else toast('请先选择教师', 'error');
    });
  }
  const all = data.teachers.slice().sort();
  initCombobox('teacher-select', all, lastTeacherSel, (val) => {
    lastTeacherSel = val;
    if (val) loadTeacherSchedule(val);
    else $('#teacher-grid').innerHTML = '';
  }, groupTeachers);
  // 如果有上次选中，立即触发一次渲染（即使该教师本周无课，也要重新加载以清除旧数据）
  if (lastTeacherSel) {
    loadTeacherSchedule(lastTeacherSel);
  } else {
    $('#teacher-grid').innerHTML = '';
    $('#teacher-conflicts').innerHTML = '';
  }
}

async function loadTeacherSchedule(teacherName) {
  const data = await api(`/api/teacher/${encodeURIComponent(teacherName)}` + weekParam());
  if (data.error) { toast(data.error, 'error'); return; }
  $('#teacher-grid').innerHTML = renderScheduleGrid(data.entries, 'teacher', data.periodLabels, data.meetingConflicts, data.teacherMeetings, data.leaveConflictKeys);
  renderTeacherConflicts(data.conflicts || []);
}

// 渲染教师课表下方的冲突提示（颜色与课表高亮一致）
function renderTeacherConflicts(conflicts) {
  const wrap = $('#teacher-conflicts');
  if (!conflicts || !conflicts.length) { wrap.innerHTML = ''; return; }
  const typeColor = {
    schedule: { color: 'var(--danger)', label: '重课冲突' },
    meeting:  { color: '#d48806', label: '会议冲突' },
    leave:    { color: '#8e44ad', label: '调休冲突' }
  };
  let html = '<div class="conflict-tips">';
  for (const c of conflicts) {
    const meta = typeColor[c.type] || { color: '#666', label: '冲突' };
    html += `<div class="conflict-tip" style="color:${meta.color}"><span class="conflict-tip-dot" style="background:${meta.color}"></span><strong>【${meta.label}】</strong>${escapeHtml(c.detail)}</div>`;
  }
  html += '</div>';
  wrap.innerHTML = html;
}

// ===== 课表网格渲染（自适应星期数 + 节次标签） =====
function renderScheduleGrid(entries, mode, globalPeriodLabels, meetingConflicts, teacherMeetings, leaveConflictKeys) {
  if (!entries.length) return noDataHtml();
  // grid: period -> Map(weekday -> entry[])  同一节课可能有多个条目（教师冲突）
  const grid = new Map();
  const periodLabels = new Map();
  let maxPeriod = 0;
  // 优先使用后端返回的全局节次标签（确保所有节次都有正确标签）
  // 构建会议冲突单元格的 key 集合（weekday|period）
  const meetingConflictKeys = new Set();
  if (meetingConflicts && meetingConflicts.length) {
    for (const mc of meetingConflicts) {
      meetingConflictKeys.add(`${mc.weekday}|${mc.period}`);
    }
  }
  // 教师需参加的会议时间（水印展示）
  const teacherMeetingMap = new Map();
  if (teacherMeetings && teacherMeetings.length) {
    for (const tm of teacherMeetings) {
      teacherMeetingMap.set(`${tm.weekday}|${tm.period}`, tm.meetingName);
    }
  }
  // 调休冲突单元格 key 集合（weekday|period）
  const leaveConflictSet = new Set();
  if (leaveConflictKeys && leaveConflictKeys.length) {
    for (const k of leaveConflictKeys) leaveConflictSet.add(k);
  }
  if (globalPeriodLabels) {
    for (const [p, label] of Object.entries(globalPeriodLabels)) {
      periodLabels.set(Number(p), label);
    }
    // 用全局节次的最大 period，保证课表完整性（即使该教师后几节没课也显示）
    const globalMax = Math.max(...Object.keys(globalPeriodLabels).map(Number));
    if (globalMax > maxPeriod) maxPeriod = globalMax;
  }
  for (const e of entries) {
    if (e.period > maxPeriod) maxPeriod = e.period;
    if (!grid.has(e.period)) grid.set(e.period, new Map());
    const dayMap = grid.get(e.period);
    if (!dayMap.has(e.weekday)) dayMap.set(e.weekday, []);
    dayMap.get(e.weekday).push(e);
    if (e.periodLabel && !periodLabels.has(e.period)) periodLabels.set(e.period, e.periodLabel);
  }
  // 固定显示周一到周天（7天），保证单周/双周布局一致
  const dayCols = [1, 2, 3, 4, 5, 6, 7];
  // 列宽比例：节次列 10%，7 个星期列各约 12.86%
  const dayCount = dayCols.length;
  const firstColPct = 10;
  const dayColPct = (100 - firstColPct) / dayCount;
  let html = '<table class="schedule-grid"><colgroup>';
  html += `<col style="width:${firstColPct.toFixed(2)}%">`;
  for (const wd of dayCols) html += `<col style="width:${dayColPct.toFixed(2)}%">`;
  html += '</colgroup><thead><tr><th>节次</th>';
  for (const wd of dayCols) html += `<th>${WEEKDAYS[wd] || '周' + wd}</th>`;
  html += '</tr></thead><tbody>';
  for (let p = 1; p <= maxPeriod; p++) {
    const label = periodLabels.get(p) || `第${p}节`;
    html += `<tr><td>${escapeHtml(label)}</td>`;
    for (const wd of dayCols) {
      const arr = (grid.get(p) || new Map()).get(wd);
      if (arr && arr.length) {
        // 去重：同班级同科目的条目只保留一个
        const seen = new Set();
        const unique = [];
        for (const e of arr) {
          const k = `${e.class}|${e.subject}`;
          if (!seen.has(k)) { seen.add(k); unique.push(e); }
        }
        // 教师模式下：同一节课不同班级 = 冲突，合并显示
        const classSet = new Set(unique.map(e => e.class || '').filter(Boolean));
        const isConflict = (mode === 'teacher' && classSet.size > 1);
        let cell = `<div class="cell-subject">${escapeHtml(unique[0].subject || '')}</div>`;
        if (mode === 'class' && unique[0].teacher) cell += `<div class="cell-teacher">${escapeHtml(unique[0].teacher)}</div>`;
        if (mode === 'teacher') {
          const classes = [...classSet];
          if (classes.length) cell += `<div class="cell-class">${escapeHtml(classes.join(' / '))}</div>`;
        }
        if (unique[0].location) cell += `<div class="cell-location">@${escapeHtml(unique[0].location)}</div>`;
        const isMeetingConflict = mode === 'teacher' && meetingConflictKeys.has(`${wd}|${p}`);
        const isLeaveConflict = mode === 'teacher' && leaveConflictSet.has(`${wd}|${p}`);
        let cellClass = 'cell-has';
        // 冲突严重性：重课(红) > 会议(橙) > 调休(紫)，同一节有多冲突时取严重性最高的颜色
        if (isConflict) cellClass = 'cell-conflict';
        else if (isMeetingConflict) cellClass = 'cell-meeting-conflict';
        else if (isLeaveConflict) cellClass = 'cell-leave-conflict';
        html += `<td class="${cellClass}">${cell}</td>`;
      } else {
        // 教师模式下，空单元格若有会议，显示水印
        if (mode === 'teacher' && teacherMeetingMap.has(`${wd}|${p}`)) {
          const mName = teacherMeetingMap.get(`${wd}|${p}`);
          html += `<td class="cell-empty cell-meeting"><span class="meeting-watermark">${escapeHtml(mName)}</span></td>`;
        } else {
          html += '<td class="cell-empty">—</td>';
        }
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// ===== 课时统计 =====
async function loadStats() {
  loadTeacherStats();
  loadClassStats();
}

async function loadTeacherStats() {
  const data = await api('/api/statistics/teachers' + weekParam());
  if (data.error || !data.teachers.length) { $('#teacher-stats-table').innerHTML = noDataHtml(); return; }
  const maxHours = Math.max(...data.teachers.map(t => t.weeklyHours), 1);
  const dayCount = Math.max(...data.teachers.map(t => Object.keys(t.dailyDistribution || {}).map(Number).filter(k => (t.dailyDistribution[k] || 0) > 0).pop() || 5), 5);
  let html = '<table class="data-table"><thead><tr><th>教师</th><th>早自习</th><th>白课</th><th>晚自习</th><th>周课时</th><th>月课时(约)</th><th>班级数</th><th>科目数</th><th>每日分布</th><th>班级</th><th>科目</th></tr></thead><tbody>';
  for (const t of data.teachers) {
    const dist = [];
    for (let wd = 1; wd <= dayCount; wd++) dist.push(t.dailyDistribution[wd] || 0);
    html += `<tr>
      <td>${escapeHtml(t.teacher)}</td>
      <td>${t.morningHours || 0}</td>
      <td>${t.dayHours || 0}</td>
      <td>${t.eveningHours || 0}</td>
      <td><strong>${t.weeklyHours}</strong></td>
      <td>${t.monthlyHours}</td>
      <td>${t.classCount}</td>
      <td>${t.subjectCount}</td>
      <td>${dist.join('/')}</td>
      <td>${t.classes.map(escapeHtml).join('、')}</td>
      <td>${t.subjects.map(escapeHtml).join('、')}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  html += '<h2 style="margin-top:24px">周课时分布图</h2>';
  html += '<div style="display:flex;flex-direction:column;gap:8px">';
  for (const t of data.teachers) {
    const w = Math.round(t.weeklyHours / maxHours * 100);
    html += `<div style="display:flex;align-items:center;gap:10px">
      <div style="width:80px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.teacher)}</div>
      <div class="bar" style="width:${w}%"></div>
      <span>${t.weeklyHours}节</span>
    </div>`;
  }
  html += '</div>';
  $('#teacher-stats-table').innerHTML = html;
}

async function loadClassStats() {
  const data = await api('/api/statistics/classes' + weekParam());
  if (data.error || !data.classes.length) { $('#class-stats-table').innerHTML = noDataHtml(); return; }
  const maxHours = Math.max(...data.classes.map(c => c.weeklyHours), 1);
  let html = '<table class="data-table"><thead><tr><th>班级</th><th>早自习</th><th>白课</th><th>晚自习</th><th>周课时</th></tr></thead><tbody>';
  for (const c of data.classes) {
    html += `<tr><td>${escapeHtml(c.class)}</td><td>${c.morningHours || 0}</td><td>${c.dayHours || 0}</td><td>${c.eveningHours || 0}</td><td><strong>${c.weeklyHours}</strong></td></tr>`;
  }
  html += '</tbody></table>';
  html += '<h2 style="margin-top:24px">班级周课时分布图</h2>';
  html += '<div style="display:flex;flex-direction:column;gap:8px">';
  for (const c of data.classes) {
    const w = Math.round(c.weeklyHours / maxHours * 100);
    html += `<div style="display:flex;align-items:center;gap:10px">
      <div style="width:100px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.class)}</div>
      <div class="bar" style="width:${w}%"></div>
      <span>${c.weeklyHours}节</span>
    </div>`;
  }
  html += '</div>';
  $('#class-stats-table').innerHTML = html;
}

// 统计 tab 切换
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    $('#tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ===== 冲突分析 =====
$('#run-analysis').addEventListener('click', runAnalysis);

// 保存当前分析结果，用于卡片筛选
let analysisData = null;
let activeFilter = 'all';  // 当前筛选的类型

async function runAnalysis() {
  const btn = $('#run-analysis');
  btn.textContent = '分析中...';
  btn.disabled = true;
  try {
    const data = await api('/api/analysis' + weekParam());
    if (data.error) { toast(data.error, 'error'); return; }
    analysisData = data;
    activeFilter = 'all';
    renderAnalysisSummary(data);
    renderAnalysisDetail(data, activeFilter);
  } finally {
    btn.textContent = '运行分析';
    btn.disabled = false;
  }
}

function renderAnalysisSummary(data) {
  const types = [
    { key: 'all', label: '冲突总数', count: data.total, type: '' },
    { key: 'teacher', label: '教师冲突', count: data.teacherConflicts, type: 'teacher' },
    { key: 'class', label: '班级冲突', count: data.classConflicts, type: 'class' },
    { key: 'room', label: '教室冲突', count: data.roomConflicts, type: 'room' },
    { key: 'meeting', label: '会议冲突', count: data.meetingConflicts || 0, type: 'meeting' },
    { key: 'leave', label: '调休冲突', count: data.leaveConflicts || 0, type: 'leave' },
  ];
  $('#analysis-summary').innerHTML = types.map(t => {
    const danger = t.count > 0 ? 'danger' : 'success';
    const active = activeFilter === t.key ? 'active' : '';
    return `<div class="stat-card ${danger} ${active}" data-filter="${t.key}" style="cursor:pointer;${active ? 'box-shadow:0 0 0 2px var(--primary);' : ''}">
      <div class="num">${t.count}</div>
      <div class="label">${t.label}</div>
    </div>`;
  }).join('');
  // 绑定点击筛选事件
  $$('#analysis-summary .stat-card').forEach(card => {
    card.addEventListener('click', () => {
      activeFilter = card.dataset.filter;
      renderAnalysisSummary(analysisData);
      renderAnalysisDetail(analysisData, activeFilter);
    });
  });
}

function renderAnalysisDetail(data, filter) {
  const detail = $('#analysis-detail');
  let conflicts = data.conflicts;
  if (filter && filter !== 'all') {
    conflicts = conflicts.filter(c => c.type === filter);
  }
  if (!conflicts.length) {
    detail.innerHTML = `<div class="card" style="text-align:center;color:var(--success)">✅ ${filter === 'all' ? '未检测到任何冲突' : '该类型无冲突'}，课表正常！</div>`;
  } else {
    detail.innerHTML = '<h2>冲突详情' + (filter !== 'all' ? `（${conflicts.length}条）` : '') + '</h2>' + conflicts.map(c => {
      const cls = c.type === 'class' ? 'warning' : c.type === 'meeting' ? 'warning' : c.type === 'leave' ? 'warning' : '';
      return `<div class="conflict-item ${cls}">
        <span class="conflict-type ${c.type}">${c.typeLabel}</span>
        <strong>${escapeHtml(c.weekdayLabel)} ${escapeHtml(c.periodLabel || '第' + c.period + '节')}</strong>
        <div class="conflict-detail">${escapeHtml(c.detail)}</div>
        <div class="conflict-entries">${c.entries.map(e =>
          `<span>[${escapeHtml(e.class||'-')}] ${escapeHtml(e.subject||'-')} / ${escapeHtml(e.teacher||'-')} ${e.location?'@'+escapeHtml(e.location):''}</span>`
        ).join('')}</div>
      </div>`;
    }).join('');
  }
}

// ===== HTML 转义 =====
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ===== 可搜索班级/教师 Combobox =====
// 中文字符串的首字母拼音映射（仅覆盖 3500 常用字 + 所有课表中出现的教师/班级名关键字）
// 轻量版：不引入完整 pinyin 库，用 lookup table 解决高频字
const __PINYIN_MAP = {
  '零':'L','一':'Y','二':'E','三':'S','四':'S','五':'W','六':'L','七':'Q','八':'B','九':'J','十':'S',
  '高':'G','二':'E','三':'S','四':'S','五':'W','六':'L','七':'Q','八':'B','九':'J',
  '初':'C','班':'B','级':'J','年':'N','小':'X','中':'Z',
  '李':'L','王':'W','张':'Z','刘':'L','陈':'C','杨':'Y','黄':'H','赵':'Z','周':'Z','吴':'W','徐':'X','孙':'S','马':'M','朱':'Z','胡':'H','郭':'G','何':'H','林':'L','罗':'L','郑':'Z','梁':'L','谢':'X','宋':'S','唐':'T','许':'X','韩':'H','冯':'F','邓':'D','曹':'C','彭':'P','曾':'Z','萧':'X','田':'T','董':'D','袁':'Y','潘':'P','于':'Y','蒋':'J','蔡':'C','余':'Y','杜':'D','叶':'Y','程':'C','苏':'S','魏':'W','吕':'L','丁':'D','任':'R','沈':'S','姚':'Y','卢':'L','傅':'F','钟':'Z','姜':'J','崔':'C','谭':'T','廖':'L','范':'F','汪':'W','陆':'L','金':'J','石':'S','戴':'D','贾':'J','韦':'W','夏':'X','邱':'Q','方':'F','侯':'H','邹':'Z','熊':'X','孟':'M','秦':'Q','白':'B','江':'J','阎':'Y','薛':'X','尹':'Y','段':'D','雷':'L','黎':'L','史':'S','龙':'L','贺':'H','顾':'G','毛':'M','郝':'H','龚':'G','邵':'S','万':'W','钱':'Q','严':'Y','覃':'Q','武':'W','戚':'Q','柳':'L','乔':'Q','齐':'Q','毛':'M','邱':'Q','易':'Y','常':'C','乔':'Q','文':'W','安':'A','殷':'Y','颜':'Y','庄':'Z','章':'Z','鲁':'L','倪':'N','庞':'P','邢':'X','俞':'Y','翟':'Z','蓝':'L','聂':'N','蔡':'C','靳':'J','路':'L','关':'G','苗':'M','季':'J','俞':'Y','简':'J','车':'C','项':'X','连':'L','梅':'M','樊':'F','詹':'Z','符':'F','阳':'Y','欧':'O','纪':'J','舒':'S','柯':'K','毕':'B','凌':'L','盛':'S','左':'Z','樊':'F','童':'T','区':'O','霍':'H','翁':'W','游':'Y','卓':'Z','阮':'R','虞':'Y','桂':'G','苟':'G','臧':'Z','闵':'M','喻':'Y','费':'F','蒲':'P','蒲':'P','解':'X','柴':'C','房':'F','姬':'J','薛':'X','秦':'Q','艾':'A','尤':'Y','兰':'L','冷':'L','饶':'R','空':'K','牧':'M','戚':'Q','瞿':'Q','辛':'X','欧':'O','管':'G','戚':'Q','曲':'Q','全':'Q','冉':'R','饶':'R','戎':'R','荣':'R','茹':'R','阮':'R','桑':'S','莎':'S','慎':'S','师':'S','施':'S','石':'S','时':'S','史':'S','舒':'S','双':'S','帅':'S','司':'S','宋':'S','苏':'S','孙':'S','索':'S',
  '语':'Y','文':'W','数':'S','学':'X','英':'Y','物':'W','理':'L','化':'H','学':'X','生':'S','物':'W','历':'L','地':'D','政':'Z','音':'Y','乐':'Y','美':'M','术':'S','信':'X','息':'X','心':'X','体':'T','育':'Y','自':'Z','习':'X',
  '晓':'X','明':'M','国':'G','建':'J','永':'Y','德':'D','志':'Z','忠':'Z','良':'L','友':'Y','祥':'X','福':'F','芳':'F','华':'H','秀':'X','丽':'L','荣':'R','珍':'Z','玲':'L','平':'P','刚':'G','强':'Q','军':'J','杰':'J','霞':'X','云':'Y','敏':'M','艳':'Y','婷':'T','佳':'J','颖':'Y','思':'S','嘉':'J','海':'H','金':'J','娟':'J','清':'Q','燕':'Y','红':'H','梅':'M','兰':'L','兰':'L','莲':'L','春':'C','秋':'Q','冬':'D','雨':'Y','雪':'X','冰':'B','月':'Y','星':'X','慧':'H','敏':'M','亮':'L','伟':'W','磊':'L','涛':'T','超':'C','鹏':'P','晨':'C','浩':'H','宇':'Y','轩':'X','文':'W','博':'B','瑞':'R','泽':'Z','俊':'J','晨':'C','思':'S','琪':'Q','瑶':'Y','璐':'L','琦':'Q','萌':'M','瑶':'Y','鑫':'X','淼':'M','森':'S','垚':'Y','焱':'Y','馨':'X','宁':'N','静':'J','远':'Y','帆':'F','航':'H','辰':'C','昊':'H','然':'R','欣':'X','逸':'Y','洋':'Y','菲':'F','莉':'L','萍':'P','桂':'G','菊':'J','莲':'L','薇':'W','莎':'S','紫':'Z','依':'Y','诗':'S','茜':'Q','含':'H','宜':'Y','瑶':'Y','娴':'X','瑾':'J','琬':'W','萱':'X','悦':'Y','妙':'M','可':'K','妙':'M',
  '琼':'Q','英':'Y','莲':'L','绍':'S','兰':'L','婷':'T','毅':'Y','璐':'L','远':'Y','先':'X','华':'H','卫':'W','红':'H','新':'X','平':'P','启':'Q','江':'J','毅':'Y','华':'H','海':'H','波':'B','华':'H','慧':'H','云':'Y','英':'Y','强':'Q','琳':'L','晓':'X','峰':'F','玲':'L','勇':'Y','秀':'X','莲':'L','莉':'L','莉':'L','莉':'L','娟':'J','兰':'L','容':'R','仙':'X','燕':'Y','莉':'L','军':'J','妹':'M','梅':'M','梅':'M','梅':'M','梅':'M','梅':'M','梅':'M',
  '晓':'X','鑫':'X','东':'D','昌':'C','进':'J','东':'D','才':'C','明':'M','飞':'F','川':'C','静':'J','敏':'M','晓':'X','梅':'M','琴':'Q','丽':'L','莉':'L','红':'H','敏':'M','敏':'M','敏':'M','敏':'M',
  '张':'Z','李':'L','周':'Z','赵':'Z','王':'W','冯':'F','陈':'C','褚':'C','卫':'W','蒋':'J','沈':'S','韩':'H','杨':'Y','朱':'Z','秦':'Q','尤':'Y','许':'X','何':'H','吕':'L','施':'S','张':'Z','孔':'K','曹':'C','严':'Y','华':'H','金':'J','魏':'W','陶':'T','姜':'J','戚':'Q','谢':'X','邹':'Z','喻':'Y','柏':'B','水':'S','窦':'D','章':'Z','云':'Y','苏':'S','潘':'P','葛':'G','奚':'X','范':'F','彭':'P','郎':'L','鲁':'L','韦':'W','昌':'C','马':'M','苗':'M','凤':'F','花':'H','方':'F','俞':'Y','任':'R','袁':'Y','柳':'L','酆':'F','鲍':'B','史':'S','唐':'T','费':'F','廉':'L','岑':'C','薛':'X','雷':'L','贺':'H','倪':'N','汤':'T','滕':'T','殷':'Y','罗':'L','毕':'B','郝':'H','邬':'W','安':'A','常':'C','乐':'L','于':'Y','时':'S','傅':'F','皮':'P','卞':'B','齐':'Q','康':'K','伍':'W','余':'Y','元':'Y','卜':'B','顾':'G','孟':'M','平':'P','黄':'H','和':'H','穆':'M','萧':'X','尹':'Y','姚':'Y','邵':'S','湛':'Z','汪':'W','祁':'Q','毛':'M','禹':'Y','狄':'D','米':'M','贝':'B','明':'M','臧':'Z','计':'J','伏':'F','成':'C','戴':'D','谈':'T','宋':'S','茅':'M','庞':'P','熊':'X','纪':'J','舒':'S','屈':'Q','项':'X','祝':'Z','董':'D','梁':'L','杜':'D','阮':'R','蓝':'L','闵':'M','席':'X','季':'J','麻':'M','强':'Q','贾':'J','路':'L','娄':'L','危':'W','江':'J','童':'T','颜':'Y','郭':'G','梅':'M','盛':'S','林':'L','刁':'D','钟':'Z','徐':'X','邱':'Q','骆':'L','高':'G','夏':'X','蔡':'C','田':'T','樊':'F','胡':'H','凌':'L','霍':'H','虞':'Y','万':'W','支':'Z','柯':'K','昝':'Z','管':'G','卢':'L','莫':'M','经':'J','房':'F','裘':'Q','缪':'M','干':'G','解':'X','应':'Y','宗':'Z','丁':'D','宣':'X','贲':'B','邓':'D','郁':'Y','单':'S','杭':'H','洪':'H','包':'B','诸':'Z','左':'Z','石':'S','崔':'C','吉':'J','钮':'N','龚':'G','程':'C','嵇':'J','邢':'X','滑':'H','裴':'P','陆':'L','荣':'R','翁':'W','荀':'X','羊':'Y','於':'Y','惠':'H','甄':'Z','曲':'Q','家':'J','封':'F','芮':'R','羿':'Y','储':'C','靳':'J','汲':'J','邴':'B','糜':'M','松':'S','井':'J','段':'D','富':'F','巫':'W','乌':'W','焦':'J','巴':'B','弓':'G','牧':'M','隗':'W','山':'S','谷':'G','车':'C','侯':'H','宓':'M','蓬':'P','全':'Q','郗':'X','班':'B','仰':'Y','秋':'Q','仲':'Z','伊':'I','宫':'G','宁':'N','仇':'Q','栾':'L','暴':'B','甘':'G','钭':'T','厉':'L','戎':'R','祖':'Z','武':'W','符':'F','刘':'L','景':'J','詹':'Z','束':'S','龙':'L','叶':'Y','幸':'X','司':'S','韶':'S','郜':'G','黎':'L','蓟':'J','薄':'B','印':'Y','宿':'S','白':'B','怀':'H','蒲':'P','邰':'T','从':'C','鄂':'E','索':'S','咸':'X','籍':'J','赖':'L','卓':'Z','蔺':'L','屠':'T','蒙':'M','池':'C','乔':'Q','阴':'Y','鬱':'Y','胥':'X','能':'N','苍':'C','双':'S','闻':'W','莘':'S','党':'D','翟':'Z','谭':'T','贡':'G','劳':'L','逄':'P','姬':'J','申':'S','扶':'F','堵':'D','冉':'R','宰':'Z','郦':'L','雍':'Y','却':'Q','璩':'Q','桑':'S','桂':'G','濮':'P','牛':'N','通':'T','边':'B','扈':'H','燕':'Y','冀':'J','郏':'J','浦':'P','尚':'S','农':'N','温':'W','别':'B','庄':'Z','晏':'Y','柴':'C','瞿':'Q','阎':'Y','充':'C','慕':'M','连':'L','茹':'R','习':'X','宦':'H','艾':'A','鱼':'Y','容':'R','向':'X','古':'G','易':'Y','慎':'S','戈':'G','廖':'L','庾':'Y','终':'Z','暨':'J','居':'J','衡':'H','步':'B','都':'D','耿':'G','满':'M','弘':'H','匡':'K','国':'G','文':'W','寇':'K','广':'G','禄':'L','阙':'Q','东':'D','欧':'O','殳':'S','沃':'W','利':'L','蔚':'Y','越':'Y','夔':'K','隆':'L','师':'S','巩':'G','厍':'S','聂':'N','晁':'C','勾':'G','敖':'A','融':'R','冷':'L','訾':'Z','辛':'X','阚':'K','那':'N','简':'J','饶':'R','空':'K','曾':'Z','毋':'W','沙':'S','乜':'N','养':'Y','鞠':'J','须':'X','丰':'F','巢':'C','关':'G','蒯':'K','相':'X','查':'Z','后':'H','荆':'J','红':'H','游':'Y','竺':'Z','权':'Q','逯':'L','盖':'G','益':'Y','桓':'H','公':'G','万俟':'W','司马':'S','上官':'S','欧阳':'O','夏侯':'X','诸葛':'Z','闻人':'W','东方':'D','赫连':'H','皇甫':'H','尉迟':'Y','公羊':'G','澹台':'T','公冶':'G','宗政':'Z','濮阳':'P','淳于':'C','单于':'C','太叔':'T','申屠':'S','公孙':'G','仲孙':'Z','轩辕':'X','令狐':'L','钟离':'Z','宇文':'Y','长孙':'Z','慕容':'M','鲜于':'X','闾丘':'L','司徒':'S','司空':'S','亓官':'Q','司寇':'S','仉':'Z','督':'D','子车':'Z','颛孙':'Z','端木':'D','巫马':'W','公西':'G','漆雕':'Q','乐正':'L','壤驷':'R','公良':'G','拓跋':'T','夹谷':'J','宰父':'Z','谷梁':'G','晋':'J','楚':'C','闫':'Y','法':'F','汝':'R','鄢':'Y','涂':'T','钦':'Q','段干':'D','百里':'B','东郭':'D','南门':'N','呼延':'H','归':'G','海':'H','羊舌':'Y','微生':'W','岳':'Y','帅':'S','缑':'G','亢':'K','况':'K','后':'H','有':'Y','琴':'Q','梁丘':'L','左丘':'Z','东门':'D','西门':'X','商':'S','牟':'M','佘':'S','佴':'N','伯':'B','赏':'S','南宫':'N','墨':'M','哈':'H','谯':'Q','笪':'D','年':'N','爱':'A','阳':'Y','佟':'T'
};
function __getPinyinInitials(str) {
  if (!str) return '';
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fa5) {
      out += __PINYIN_MAP[ch] || '';
    } else if (code >= 65 && code <= 90) {
      out += ch;
    } else if (code >= 97 && code <= 122) {
      out += ch.toUpperCase();
    } else if (code >= 48 && code <= 57) {
      out += ch;
    }
  }
  return out;
}
/**
 * 初始化搜索型下拉（替代原始 <select>）
 * @param {string} id   - combobox input 元素 id（如 'class-select' / 'teacher-select'）
 * @param {string[]} allOptions - 所有候选项（班级或教师名单）
 * @param {string} initValue - 初始选中值
 * @param {(val:string)=>void} onSelect - 选中回调
 * @param {(list:string[])=>{groupTitle:string,items:string[]}[]} [groupFn] - 可选，分组函数（把所有选项拆为多组，每组有标题）
 */
function initCombobox(id, allOptions, initValue, onSelect, groupFn) {
  const input = document.getElementById(id);
  if (!input) return;
  const ddId = id + '-dropdown';
  const dropdown = document.getElementById(ddId);
  const toggleBtn = input.parentElement.querySelector('.combobox-toggle');

  input._allOptions = allOptions;
  input._groupFn = groupFn;
  input._onSelect = onSelect;
  input._activeIdx = -1;
  input._filteredList = []; // 扁平的当前可视项字符串数组（不含组标题）
  input._value = initValue || '';

  if (initValue) input.value = initValue;

  // --- 渲染下拉内容 ---
  function render(showAll) {
    const q = showAll ? '' : input.value.trim();
    const qLower = q.toLowerCase();
    // 1. 先过滤
    let filtered;
    if (!q) {
      filtered = [...allOptions];
    } else {
      filtered = allOptions.filter(opt => {
        const optLower = opt.toLowerCase();
        const pyInitials = __getPinyinInitials(opt).toLowerCase();
        return opt.includes(q) || optLower.includes(qLower) || pyInitials.includes(qLower);
      });
    }
    // 2. 高亮匹配片段（用 <mark> 包匹配部分）
    function highlight(text, query) {
      if (!query) return escapeHtml(text);
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx >= 0) {
        return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>' + escapeHtml(text.slice(idx + query.length));
      }
      // 拼音匹配：不高亮原字符串内部字符
      return escapeHtml(text);
    }
    // 3. 分组
    let groups;
    if (groupFn) groups = groupFn(filtered);
    else groups = [{ groupTitle: '', items: filtered }];
    // 4. 生成 HTML
    const flat = [];
    let html = '';
    let hasAny = false;
    for (const g of groups) {
      if (!g.items.length) continue;
      hasAny = true;
      if (g.groupTitle) html += `<div class="combobox-group-title">${escapeHtml(g.groupTitle)}</div>`;
      for (let i = 0; i < g.items.length; i++) {
        const item = g.items[i];
        const flatIdx = flat.length;
        flat.push(item);
        const isActive = (flatIdx === input._activeIdx) || (item === input._value && input._activeIdx < 0);
        html += `<div class="combobox-item${isActive ? ' active' : ''}" data-value="${escapeAttr(item)}" data-flat="${flatIdx}">${highlight(item, q)}</div>`;
      }
    }
    if (!hasAny) html = `<div class="combobox-empty">没有匹配的${id.includes('class') ? '班级' : '教师'}，试试其他关键字</div>`;
    dropdown.innerHTML = html;
    input._filteredList = flat;
    // 5. 绑定每项点击：mousedown 用于真实鼠标（避免 input blur 关闭 dropdown），click 用于键盘/编程触发
    dropdown.querySelectorAll('.combobox-item').forEach(el => {
      el.addEventListener('mouseenter', () => {
        input._activeIdx = Number(el.dataset.flat);
        dropdown.querySelectorAll('.combobox-item').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
      });
      // 真实鼠标点击下拉项：
      // mousedown 阻止 input 失焦（避免 input blur 把 dropdown 关掉）
      // pick 交给 click 处理
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });
      el.addEventListener('click', (e) => {
        e.stopPropagation();  // 阻止冒泡到 document
        pick(el.dataset.value);
      });
    });
  }

  function pick(val) {
    input._value = val;
    input.value = val;
    closeDD();
    if (onSelect) onSelect(val);
  }

  function openDD(showAll) {
    render(showAll);
    dropdown.classList.add('open');
  }
  function closeDD() { dropdown.classList.remove('open'); }

  // 事件绑定：如果已经绑定过就不重绑（data.bound）
  if (!input.dataset.bound) {
    input.dataset.bound = 1;
    input.addEventListener('focus', () => openDD(true));
    input.addEventListener('input', () => {
      input._activeIdx = -1;
      openDD();
    });
    input.addEventListener('click', () => { if (!dropdown.classList.contains('open')) openDD(true); });
    input.addEventListener('keydown', (e) => {
      const list = input._filteredList;
      if (!dropdown.classList.contains('open')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { openDD(true); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        input._activeIdx = Math.min(list.length - 1, input._activeIdx + 1);
        syncActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        input._activeIdx = Math.max(0, input._activeIdx - 1);
        syncActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (input._activeIdx >= 0 && list[input._activeIdx]) pick(list[input._activeIdx]);
        else if (list.length === 1) pick(list[0]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeDD();
      }
    });
    // 真实鼠标点击 ▾ 按钮：
    // mousedown 阻止 input 失焦（避免 input blur 把 dropdown 关掉）
    // 实际切换 open/close 交给 click 处理（避免 mousedown/click 双重切换导致关了又开）
    toggleBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    // click：切换 dropdown 开/关
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();  // 阻止冒泡到 document（否则 document click 又把刚开的 dropdown 关掉）
      if (dropdown.classList.contains('open')) closeDD();
      else { openDD(true); input.focus(); }
    });
    // 点击外部关闭（不在 .combobox 内的点击）
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.combobox')) closeDD();
    });
  }

  function syncActive() {
    dropdown.querySelectorAll('.combobox-item').forEach(el => {
      const i = Number(el.dataset.flat);
      if (i === input._activeIdx) {
        el.classList.add('active');
        el.scrollIntoView({ block: 'nearest' });
      } else el.classList.remove('active');
    });
  }
}
// 班级分组：按年级前缀（24xx=高三? 25xx=高二? 26xx=高一?）+ 其他
function groupClasses(list) {
  const groups = new Map();
  function groupOf(c) {
    const m = c.match(/^(\d{2})(\d{2})$/);
    if (m) {
      const yy = m[1];
      // 基于用户的高中总课表2026级=高一，25级=高二，24级=高三
      const label = { '26': '高一（26级）', '25': '高二（25级）', '24': '高三（24级）' };
      return label[yy] || (yy + '级');
    }
    if (/^高一/.test(c)) return '高一';
    if (/^高二/.test(c)) return '高二';
    if (/^高三/.test(c)) return '高三';
    if (/^初/.test(c)) return '初中';
    return '其他班级';
  }
  for (const c of list) {
    const k = groupOf(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  // 按年级顺序排序（高三→高二→高一→初中→其他）
  const order = ['高三（24级）','高三','高二（25级）','高二','高一（26级）','高一','初中'];
  const entries = [...groups.entries()].sort((a,b) => {
    const ai = order.indexOf(a[0]); const bi = order.indexOf(b[0]);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a[0].localeCompare(b[0], 'zh');
  });
  for (const [,items] of entries) items.sort();
  return entries.map(([g,items]) => ({ groupTitle: g, items }));
}
// 教师分组：按首字母分组（拼音首字母）
function groupTeachers(list) {
  const groups = new Map();
  for (const t of list) {
    const initial = __getPinyinInitials(t.charAt(0)).toUpperCase() || '#';
    const key = initial.charAt(0);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const entries = [...groups.entries()].sort((a,b) => a[0].localeCompare(b[0]));
  for (const [,items] of entries) items.sort();
  return entries.map(([k,items]) => ({ groupTitle: k, items }));
}


// ===== 初始化 =====
checkData();

// ===== 课表调整功能 =====
let rejectTooltip = null;
function ensureRejectTooltip() {
  if (!rejectTooltip) {
    rejectTooltip = document.createElement('div');
    rejectTooltip.className = 'swap-reject-tooltip';
    document.body.appendChild(rejectTooltip);
  }
  return rejectTooltip;
}

// 课表类型切换
$('#swap-mode-select').addEventListener('change', () => {
  swapState.mode = $('#swap-mode-select').value;
  if (swapState.mode === 'teacher') {
    $('#swap-teacher-group').style.display = '';
    $('#swap-class-group').style.display = 'none';
  } else {
    $('#swap-teacher-group').style.display = 'none';
    $('#swap-class-group').style.display = '';
  }
  resetSwapSelection();
  loadSwapGrid();
});

// 班级选择切换
$('#swap-class-select').addEventListener('change', async () => {
  swapState.class = $('#swap-class-select').value;
  resetSwapSelection();
  await loadSwapGrid();
});

// 执行调整
$('#swap-execute-btn').addEventListener('click', executeSwapAction);
// 撤销
$('#swap-undo-btn').addEventListener('click', undoSwapAction);

// 调课视图加载
async function loadSwapView() {
  const data = await api('/api/teachers' + weekParam());
  if (data.error) { $('#swap-grid').innerHTML = noDataHtml(); return; }
  const all = data.teachers.slice().sort();
  initCombobox('swap-teacher-select', all, lastTeacherSel, async (val) => {
    lastTeacherSel = val;
    swapState.teacher = val;
    swapState.source = null;
    swapState.target = null;
    swapState.candidates = [];
    $('#swap-execute-btn').disabled = true;
    if (val) await onSwapTeacherSelected(val);
    else { resetSwapState(); $('#swap-grid').innerHTML = ''; }
  }, groupTeachers);
  // 如果有上次选中，立即触发
  if (lastTeacherSel && all.includes(lastTeacherSel)) {
    swapState.teacher = lastTeacherSel;
    await onSwapTeacherSelected(lastTeacherSel);
  } else {
    $('#swap-grid').innerHTML = '';
  }
}

// 教师选中后：加载该教师的课表作为调课主网格
async function onSwapTeacherSelected(teacherName) {
  const data = await api(`/api/teacher/${encodeURIComponent(teacherName)}` + weekParam());
  if (data.error) { toast(data.error, 'error'); return; }
  swapState.periodLabels = data.periodLabels;
  // 教师模式下，主网格显示教师课表，但调课仍是在班级内对调
  // 用户在教师课表中选中某节课后，系统找到该课所属班级，然后计算该班内的可对调课程
  $('#swap-grid-title').textContent = `${teacherName} 课表`;
  $('#swap-grid').innerHTML = renderSwapGrid(data.entries, 'teacher', data.periodLabels, data.meetingConflicts, data.teacherMeetings);
  // 清空参考课表
  $('#swap-source-teacher-title').textContent = '当前选中课程的老师课表';
  $('#swap-source-teacher-grid').innerHTML = '';
  $('#swap-target-teacher-title').textContent = '对调老师课程表';
  $('#swap-target-teacher-grid').innerHTML = '';
}

// 加载调课网格（班级模式）
async function loadSwapGrid() {
  if (swapState.mode === 'teacher') {
    if (swapState.teacher) await onSwapTeacherSelected(swapState.teacher);
  } else {
    if (!swapState.class) {
      // 填充班级下拉
      const data = await api('/api/classes' + weekParam());
      if (data.error) return;
      const sel = $('#swap-class-select');
      sel.innerHTML = data.classes.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
      if (data.classes.length) {
        swapState.class = data.classes[0];
        sel.value = data.classes[0];
      }
    }
    if (swapState.class) {
      const data = await api(`/api/class/${encodeURIComponent(swapState.class)}` + weekParam());
      if (data.error) { toast(data.error, 'error'); return; }
      swapState.periodLabels = data.periodLabels;
      $('#swap-grid-title').textContent = `${swapState.class} 课表`;
      $('#swap-grid').innerHTML = renderSwapGrid(data.entries, 'class', data.periodLabels);
      $('#swap-source-teacher-title').textContent = '当前选中课程的老师课表';
      $('#swap-source-teacher-grid').innerHTML = '';
      $('#swap-target-teacher-title').textContent = '对调老师课程表';
      $('#swap-target-teacher-grid').innerHTML = '';
    }
  }
}

// 调课专用网格渲染：每个单元格带 data-* 属性，用于点击交互
function renderSwapGrid(entries, mode, globalPeriodLabels, meetingConflicts, teacherMeetings, highlightTeacher) {
  if (!entries.length) return noDataHtml();
  const grid = new Map();
  const periodLabels = new Map();
  let maxPeriod = 0;
  const meetingConflictKeys = new Set();
  if (meetingConflicts && meetingConflicts.length) {
    for (const mc of meetingConflicts) meetingConflictKeys.add(`${mc.weekday}|${mc.period}`);
  }
  const teacherMeetingMap = new Map();
  if (teacherMeetings && teacherMeetings.length) {
    for (const tm of teacherMeetings) teacherMeetingMap.set(`${tm.weekday}|${tm.period}`, tm.meetingName);
  }
  if (globalPeriodLabels) {
    for (const [p, label] of Object.entries(globalPeriodLabels)) periodLabels.set(Number(p), label);
    const globalMax = Math.max(...Object.keys(globalPeriodLabels).map(Number));
    if (globalMax > maxPeriod) maxPeriod = globalMax;
  }
  for (const e of entries) {
    if (e.period > maxPeriod) maxPeriod = e.period;
    if (!grid.has(e.period)) grid.set(e.period, new Map());
    const dayMap = grid.get(e.period);
    if (!dayMap.has(e.weekday)) dayMap.set(e.weekday, []);
    dayMap.get(e.weekday).push(e);
    if (e.periodLabel && !periodLabels.has(e.period)) periodLabels.set(e.period, e.periodLabel);
  }
  const dayCols = [1, 2, 3, 4, 5, 6, 7];
  const firstColPct = 10;
  const dayColPct = (100 - firstColPct) / dayCols.length;
  let html = '<table class="schedule-grid"><colgroup>';
  html += `<col style="width:${firstColPct.toFixed(2)}%">`;
  for (const wd of dayCols) html += `<col style="width:${dayColPct.toFixed(2)}%">`;
  html += '</colgroup><thead><tr><th>节次</th>';
  for (const wd of dayCols) html += `<th>${WEEKDAYS[wd] || '周' + wd}</th>`;
  html += '</tr></thead><tbody>';
  for (let p = 1; p <= maxPeriod; p++) {
    const label = periodLabels.get(p) || `第${p}节`;
    html += `<tr><td>${escapeHtml(label)}</td>`;
    for (const wd of dayCols) {
      const arr = (grid.get(p) || new Map()).get(wd);
      if (arr && arr.length) {
        const seen = new Set();
        const unique = [];
        for (const e of arr) {
          const k = `${e.class}|${e.subject}`;
          if (!seen.has(k)) { seen.add(k); unique.push(e); }
        }
        const classSet = new Set(unique.map(e => e.class || '').filter(Boolean));
        const isConflict = (mode === 'teacher' && classSet.size > 1);
        let cell = `<div class="cell-subject">${escapeHtml(unique[0].subject || '')}</div>`;
        if (mode === 'class' && unique[0].teacher) cell += `<div class="cell-teacher">${escapeHtml(unique[0].teacher)}</div>`;
        if (mode === 'teacher') {
          const classes = [...classSet];
          if (classes.length) cell += `<div class="cell-class">${escapeHtml(classes.join(' / '))}</div>`;
        }
        if (unique[0].location) cell += `<div class="cell-location">@${escapeHtml(unique[0].location)}</div>`;
        const isMeetingConflict = mode === 'teacher' && meetingConflictKeys.has(`${wd}|${p}`);
        let cellClass = 'cell-has';
        if (isConflict) cellClass = 'cell-conflict';
        else if (isMeetingConflict) cellClass = 'cell-meeting-conflict';
        else if (highlightTeacher && unique[0].teacher === highlightTeacher) cellClass = 'cell-own-teacher';
        // 取第一个条目的信息作为 data 属性
        const e0 = unique[0];
        html += `<td class="${cellClass}" data-weekday="${wd}" data-period="${p}" data-class="${escapeAttr(e0.class || '')}" data-teacher="${escapeAttr(e0.teacher || '')}" data-subject="${escapeAttr(e0.subject || '')}">${cell}</td>`;
      } else {
        if (mode === 'teacher' && teacherMeetingMap.has(`${wd}|${p}`)) {
          const mName = teacherMeetingMap.get(`${wd}|${p}`);
          html += `<td class="cell-empty cell-meeting" data-weekday="${wd}" data-period="${p}"><span class="meeting-watermark">${escapeHtml(mName)}</span></td>`;
        } else {
          html += `<td class="cell-empty" data-weekday="${wd}" data-period="${p}">—</td>`;
        }
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// 调课网格点击事件代理
$('#swap-grid').addEventListener('click', async (e) => {
  const td = e.target.closest('td');
  if (!td || !td.dataset.weekday) return;
  const weekday = Number(td.dataset.weekday);
  const period = Number(td.dataset.period);
  // 1. 无源课程 → 选源（红色）
  if (!swapState.source) {
    if (td.classList.contains('cell-empty')) { toast('空课不可选', 'error'); return; }
    await selectSource(td, weekday, period);
  } else {
    // 2. 已有源课程
    if (swapState.source.weekday === weekday && swapState.source.period === period) {
      resetSwapSelection();
      // 教师模式下恢复教师课表视图
      if (swapState.mode === 'teacher' && swapState.teacher) {
        await onSwapTeacherSelected(swapState.teacher);
      }
      return;
    }
    if (td.classList.contains('cell-swap-able')) {
      selectTarget(weekday, period);
    } else if (td.classList.contains('cell-swap-target')) {
      swapState.target = null;
      $('#swap-execute-btn').disabled = true;
      renderSwapGridState();
    }
  }
});

// 右键查看禁选原因
$('#swap-grid').addEventListener('contextmenu', (e) => {
  const td = e.target.closest('td');
  if (!td || !td.dataset.weekday) return;
  e.preventDefault();
  const weekday = Number(td.dataset.weekday);
  const period = Number(td.dataset.period);
  const tooltip = ensureRejectTooltip();
  const cand = swapState.candidates.find(c => c.weekday === weekday && c.period === period);
  if (cand && !cand.swappable && cand.rejectReason) {
    tooltip.textContent = cand.rejectReason;
    tooltip.style.display = 'block';
    tooltip.style.left = e.clientX + 10 + 'px';
    tooltip.style.top = e.clientY + 10 + 'px';
  } else if (swapState.source && swapState.source.weekday === weekday && swapState.source.period === period) {
    tooltip.textContent = '这是当前选中的源课程';
    tooltip.style.display = 'block';
    tooltip.style.left = e.clientX + 10 + 'px';
    tooltip.style.top = e.clientY + 10 + 'px';
  } else {
    tooltip.style.display = 'none';
  }
});

// 点击其他位置隐藏禁选提示
document.addEventListener('click', () => {
  if (rejectTooltip) rejectTooltip.style.display = 'none';
});

// 选中源课程
async function selectSource(td, weekday, period) {
  const className = td.dataset.class;
  const teacher = td.dataset.teacher;
  const subject = td.dataset.subject;
  if (!teacher) { toast('该课程无教师，不可调', 'error'); return; }
  swapState.source = { class: className, weekday, period, teacher, subject };
  swapState.target = null;
  $('#swap-execute-btn').disabled = true;
  // 调用 API 获取候选（基于源课程所在班级）
  const url = `/api/swap/candidates?className=${encodeURIComponent(className)}&weekday=${weekday}&period=${period}` + weekParam('&');
  const data = await api(url);
  if (data.error) { toast(data.error, 'error'); resetSwapSelection(); return; }
  swapState.candidates = data.candidates || [];
  // 切换为班级课表视图，让所有单元格显示科目和教师
  const classData = await api(`/api/class/${encodeURIComponent(className)}` + weekParam());
  if (!classData.error) {
    swapState.periodLabels = classData.periodLabels;
    $('#swap-grid-title').textContent = `${className} 课表（调课中：${teacher}）`;
    $('#swap-grid').innerHTML = renderSwapGrid(classData.entries, 'class', classData.periodLabels, null, null, teacher);
  }
  renderSwapGridState();
  // 加载源教师参考课表
  await loadRefSchedule('source', teacher);
}

// 选中目标课程
function selectTarget(weekday, period) {
  const cand = swapState.candidates.find(c => c.weekday === weekday && c.period === period);
  if (!cand || !cand.swappable) return;
  swapState.target = {
    class: swapState.source.class,
    weekday, period,
    teacher: cand.teacher,
    subject: cand.subject
  };
  $('#swap-execute-btn').disabled = false;
  renderSwapGridState();
  loadRefSchedule('target', cand.teacher);
}

// 渲染调课网格状态（高亮颜色）
function renderSwapGridState() {
  const tds = $$('#swap-grid td[data-weekday]');
  tds.forEach(td => {
    td.classList.remove('cell-swap-selected', 'cell-swap-able', 'cell-swap-target', 'cell-swap-disabled');
  });
  if (!swapState.source) return;
  // 高亮源课程（红色）
  const srcTd = $(`#swap-grid td[data-weekday="${swapState.source.weekday}"][data-period="${swapState.source.period}"]`);
  if (srcTd) srcTd.classList.add('cell-swap-selected');
  // 高亮可对调/禁选
  for (const cand of swapState.candidates) {
    const td = $(`#swap-grid td[data-weekday="${cand.weekday}"][data-period="${cand.period}"]`);
    if (!td) continue;
    if (cand.swappable) td.classList.add('cell-swap-able');
    else td.classList.add('cell-swap-disabled');
  }
  // 高亮目标（绿色）
  if (swapState.target) {
    const tgtTd = $(`#swap-grid td[data-weekday="${swapState.target.weekday}"][data-period="${swapState.target.period}"]`);
    if (tgtTd) {
      tgtTd.classList.remove('cell-swap-able');
      tgtTd.classList.add('cell-swap-target');
    }
  }
}

// 加载参考课表
async function loadRefSchedule(type, teacherName) {
  if (!teacherName) return;
  const data = await api(`/api/teacher/${encodeURIComponent(teacherName)}` + weekParam());
  if (data.error) return;
  const html = renderScheduleGrid(data.entries, 'teacher', data.periodLabels, data.meetingConflicts, data.teacherMeetings, data.leaveConflictKeys);
  if (type === 'source') {
    $('#swap-source-teacher-title').textContent = `当前选中课程的老师课表：${teacherName}`;
    $('#swap-source-teacher-grid').innerHTML = html;
  } else {
    $('#swap-target-teacher-title').textContent = `对调老师课程表：${teacherName}`;
    $('#swap-target-teacher-grid').innerHTML = html;
  }
}

// 执行对调
async function executeSwapAction() {
  if (!swapState.source || !swapState.target) return;
  const btn = $('#swap-execute-btn');
  btn.disabled = true;
  btn.textContent = '调整中...';
  try {
    const result = await api('/api/swap/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: swapState.source,
        target: swapState.target,
        week: currentWeek
      })
    });
    if (result.error) { toast(result.error, 'error'); return; }
    toast('对调成功', 'success');
    swapState.canUndo = true;
    $('#swap-undo-btn').disabled = false;
    // 刷新调课网格
    if (swapState.mode === 'teacher') {
      await onSwapTeacherSelected(swapState.teacher);
    } else {
      $('#swap-grid').innerHTML = renderSwapGrid(result.classEntries, 'class', result.periodLabels);
    }
    swapState.periodLabels = result.periodLabels;
    // 刷新参考课表
    await loadRefSchedule('source', result.sourceTeacherName || swapState.source.teacher);
    if (result.targetTeacherName) await loadRefSchedule('target', result.targetTeacherName);
    resetSwapSelection();
    // 教师模式下恢复教师课表视图
    if (swapState.mode === 'teacher' && swapState.teacher) {
      await onSwapTeacherSelected(swapState.teacher);
    }
    // 同步刷新教师课表视图
    if (lastTeacherSel && activeView === 'teacher') loadTeacherSchedule(lastTeacherSel);
  } finally {
    btn.disabled = true;
    btn.textContent = '执行调整';
  }
}

// 撤销对调
async function undoSwapAction() {
  const result = await api('/api/swap/undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ week: currentWeek })
  });
  if (result.error) { toast(result.error, 'error'); return; }
  toast('已撤销', 'success');
  swapState.canUndo = false;
  $('#swap-undo-btn').disabled = true;
  // 刷新调课网格
  if (swapState.mode === 'teacher') {
    if (swapState.teacher) await onSwapTeacherSelected(swapState.teacher);
  } else {
    if (swapState.class) {
      const classData = await api(`/api/class/${encodeURIComponent(swapState.class)}` + weekParam());
      if (!classData.error) {
        $('#swap-grid').innerHTML = renderSwapGrid(classData.entries, 'class', classData.periodLabels);
      }
    }
  }
  resetSwapSelection();
  if (lastTeacherSel && activeView === 'teacher') loadTeacherSchedule(lastTeacherSel);
}

function resetSwapSelection() {
  swapState.source = null;
  swapState.target = null;
  swapState.candidates = [];
  $('#swap-execute-btn').disabled = true;
  $$('#swap-grid td[data-weekday]').forEach(td => {
    td.classList.remove('cell-swap-selected', 'cell-swap-able', 'cell-swap-target', 'cell-swap-disabled');
  });
  $('#swap-source-teacher-title').textContent = '当前选中课程的老师课表';
  $('#swap-source-teacher-grid').innerHTML = '';
  $('#swap-target-teacher-title').textContent = '对调老师课程表';
  $('#swap-target-teacher-grid').innerHTML = '';
}

function resetSwapState() {
  resetSwapSelection();
  swapState.class = '';
  swapState.canUndo = false;
  $('#swap-undo-btn').disabled = true;
}
