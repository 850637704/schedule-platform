// 课表分析工具：冲突检测
// 冲突类型：
//   1. 教师冲突：同一教师在同一时段被安排到多个班级
//   2. 班级冲突：同一班级在同一时段被安排多位教师/科目
//   3. 教室冲突：同一教室在同一时段被多个班级使用（可选）
//   4. 会议冲突：教师在会议时间被排课（如物理老师在理综组会时间排课）

const { MEETING_SUBJECT_MAP } = require('./parser');

const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEK_TYPES = ['单周', '双周', '通用'];

// 从一组条目中取节次标签（用于展示）
function getPeriodLabel(group) {
  for (const e of group) {
    if (e.periodLabel) return e.periodLabel;
  }
  return null;
}

// 将 weekTypes 集合格式化为前缀
function formatWeekPrefix(weekTypes) {
  if (!weekTypes || weekTypes.size === 0) return '';
  const has1 = weekTypes.has('单周') || weekTypes.has('通用');
  const has2 = weekTypes.has('双周') || weekTypes.has('通用');
  if (has1 && has2) return '(单双周)';
  if (has1) return '(单周)';
  if (has2) return '(双周)';
  return '';
}

// 对单周/双周的 entries 运行冲突检测，返回原始冲突列表
function detectConflicts(entries, meetings, teacherMap) {
  const teacherSlots = new Map();
  const classSlots = new Map();
  const roomSlots = new Map();

  for (const e of entries) {
    if (e.teacher) {
      const k = `${e.teacher}|${e.weekday}|${e.period}`;
      if (!teacherSlots.has(k)) teacherSlots.set(k, []);
      teacherSlots.get(k).push(e);
    }
    if (e.class) {
      const k = `${e.class}|${e.weekday}|${e.period}`;
      if (!classSlots.has(k)) classSlots.set(k, []);
      classSlots.get(k).push(e);
    }
    if (e.location) {
      const k = `${e.location}|${e.weekday}|${e.period}`;
      if (!roomSlots.has(k)) roomSlots.set(k, []);
      roomSlots.get(k).push(e);
    }
  }

  const conflicts = [];

  // 教师冲突
  for (const [k, group] of teacherSlots) {
    if (group.length > 1) {
      const [teacher, wd, pd] = k.split('|');
      conflicts.push({
        type: 'teacher',
        teacher,
        weekday: Number(wd),
        period: Number(pd),
        periodLabel: getPeriodLabel(group),
        detail: `教师「${teacher}」在 ${weekdayNames[Number(wd)]} ${getPeriodLabel(group) || '第' + pd + '节'} 同时被安排到 ${group.length} 个班级`,
        entries: group,
        _key: k
      });
    }
  }

  // 班级冲突
  for (const [k, group] of classSlots) {
    if (group.length > 1) {
      const [cls, wd, pd] = k.split('|');
      const subjects = new Set(group.map(g => g.subject));
      if (subjects.size > 1) {
        conflicts.push({
          type: 'class',
          class: cls,
          weekday: Number(wd),
          period: Number(pd),
          periodLabel: getPeriodLabel(group),
          detail: `班级「${cls}」在 ${weekdayNames[Number(wd)]} ${getPeriodLabel(group) || '第' + pd + '节'} 被安排 ${group.length} 门不同课程`,
          entries: group,
          _key: k
        });
      }
    }
  }

  // 教室冲突
  for (const [k, group] of roomSlots) {
    if (group.length > 1) {
      const [room, wd, pd] = k.split('|');
      const classes = new Set(group.map(g => g.class));
      if (classes.size > 1) {
        conflicts.push({
          type: 'room',
          location: room,
          weekday: Number(wd),
          period: Number(pd),
          periodLabel: getPeriodLabel(group),
          detail: `教室「${room}」在 ${weekdayNames[Number(wd)]} ${getPeriodLabel(group) || '第' + pd + '节'} 被多个班级占用`,
          entries: group,
          _key: k
        });
      }
    }
  }

  // 会议冲突：教师在会议时间被排课
  if (meetings && meetings.length && teacherMap) {
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
    for (const meeting of meetings) {
      const meetingSubjects = MEETING_SUBJECT_MAP[meeting.name] || [];
      const meetingTeachers = new Set();
      for (const subj of meetingSubjects) {
        if (subjectTeachers[subj]) {
          for (const t of subjectTeachers[subj]) meetingTeachers.add(t);
        }
      }
      if (!meetingTeachers.size) continue;
      for (const entry of entries) {
        if (entry.weekday === meeting.weekday && entry.periodLabel === meeting.periodLabel &&
            meetingTeachers.has(entry.teacher) && entry.teacher) {
          const k = `${meeting.name}|${entry.teacher}|${entry.weekday}|${entry.period}`;
          conflicts.push({
            type: 'meeting',
            teacher: entry.teacher,
            meeting: meeting.name,
            weekday: meeting.weekday,
            period: entry.period,
            periodLabel: meeting.periodLabel,
            detail: `教师「${entry.teacher}」在 ${weekdayNames[meeting.weekday]} ${meeting.periodLabel} 有「${meeting.name}」，但同时被安排了 ${entry.subject}（${entry.class}）`,
            entries: [entry],
            _key: k
          });
        }
      }
    }
  }

  return conflicts;
}

// 合并冲突：同一 _key 在单周和双周都有时，标注 (单双周)
function analyzeConflicts(allEntries, meetings, teacherMap) {
  // 按周次分组检测
  const weekResults = {};
  for (const wt of WEEK_TYPES) {
    const entries = allEntries.filter(e => (e.weekType || '通用') === wt);
    if (entries.length === 0) continue;
    weekResults[wt] = detectConflicts(entries, meetings, teacherMap);
  }

  // 合并：_key -> { weekTypes: Set, conflict: obj }
  const merged = new Map();
  for (const [wt, conflicts] of Object.entries(weekResults)) {
    for (const c of conflicts) {
      const key = `${c.type}|${c._key}`;
      if (!merged.has(key)) {
        merged.set(key, { weekTypes: new Set(), conflict: c });
      }
      merged.get(key).weekTypes.add(wt);
    }
  }

  // 生成最终冲突列表（加周次前缀）
  const conflicts = [];
  for (const [, info] of merged) {
    const c = info.conflict;
    const prefix = formatWeekPrefix(info.weekTypes);
    // 在 detail 中给星期前加周次前缀
    const wdName = weekdayNames[c.weekday];
    const detailWithPrefix = c.detail.replace(
      wdName,
      `${prefix}${wdName}`
    );
    conflicts.push({
      type: c.type,
      typeLabel: c.type === 'teacher' ? '教师冲突' : c.type === 'class' ? '班级冲突' : c.type === 'room' ? '教室冲突' : '会议冲突',
      teacher: c.teacher,
      class: c.class,
      meeting: c.meeting,
      location: c.location,
      weekday: c.weekday,
      weekdayLabel: `${prefix}${wdName}`,
      period: c.period,
      periodLabel: c.periodLabel,
      detail: detailWithPrefix,
      entries: c.entries,
      weekTypes: [...info.weekTypes]
    });
  }

  // 按教师/班级/会议名分组排序，同一教师的冲突放一起，再按时段排序
  conflicts.sort((a, b) => {
    const keyA = a.teacher || a.class || a.meeting || a.location || '';
    const keyB = b.teacher || b.class || b.meeting || b.location || '';
    if (keyA !== keyB) return keyA.localeCompare(keyB, 'zh');
    return a.weekday - b.weekday || a.period - b.period;
  });

  return {
    total: conflicts.length,
    teacherConflicts: conflicts.filter(c => c.type === 'teacher').length,
    classConflicts: conflicts.filter(c => c.type === 'class').length,
    roomConflicts: conflicts.filter(c => c.type === 'room').length,
    meetingConflicts: conflicts.filter(c => c.type === 'meeting').length,
    conflicts
  };
}

// 基础统计信息
function getStats(entries) {
  const classes = new Set();
  const teachers = new Set();
  const subjects = new Set();
  for (const e of entries) {
    if (e.class) classes.add(e.class);
    if (e.teacher) teachers.add(e.teacher);
    if (e.subject) subjects.add(e.subject);
  }
  return {
    totalEntries: entries.length,
    classCount: classes.size,
    teacherCount: teachers.size,
    subjectCount: subjects.size,
    classes: [...classes].sort(),
    teachers: [...teachers].sort(),
    subjects: [...subjects].sort()
  };
}

module.exports = { analyzeConflicts, getStats };
