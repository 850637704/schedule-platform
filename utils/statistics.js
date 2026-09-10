// 课时统计工具：教师周/月课时统计
const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 节次标签 -> 时段类型：早自习 / 白课 / 晚自习
function periodType(periodLabel) {
  const s = String(periodLabel || '');
  if (/早/.test(s)) return 'morning';      // 早自习
  if (/晚/.test(s)) return 'evening';     // 晚自习
  return 'day';                            // 白课（1-8）
}

// 判断是否为自习科目（自习、自习课等）
function isSelfStudySubject(subject) {
  return subject ? /自习/.test(subject) : false;
}

// 判断是否为班会科目（班会、主题班会等）
function isClassMeetingSubject(subject) {
  return subject ? /班会/.test(subject) : false;
}

// 教师课时统计
// 周课时 = 教师在本周排的课节数（按不同星期+节次去重）
// 分别统计 早自习 / 白课(1-8) / 晚自习(晚1-晚4) / 班会 / 自习
// 班会、自习：科目匹配即计入对应列，不计入白课/晚自习
function teacherStatistics(entries) {
  // teacher -> Map(slotKey -> { periodLabel, subjects: Set })
  const teacherSlots = new Map();
  const teacherClasses = new Map();
  const teacherSubjects = new Map();
  for (const e of entries) {
    if (!e.teacher) continue;
    const key = `${e.weekday}|${e.period}`;
    if (!teacherSlots.has(e.teacher)) {
      teacherSlots.set(e.teacher, new Map());
      teacherClasses.set(e.teacher, new Set());
      teacherSubjects.set(e.teacher, new Set());
    }
    const slotMap = teacherSlots.get(e.teacher);
    if (!slotMap.has(key)) {
      slotMap.set(key, { periodLabel: e.periodLabel, subjects: new Set() });
    }
    if (e.subject) slotMap.get(key).subjects.add(e.subject);
    if (e.class) teacherClasses.get(e.teacher).add(e.class);
    if (e.subject) teacherSubjects.get(e.teacher).add(e.subject);
  }
  const result = [];
  for (const [teacher, slotMap] of teacherSlots) {
    const morning = new Set();
    const day = new Set();
    const evening = new Set();
    const classMeeting = new Set();
    const selfStudy = new Set();
    for (const [key, info] of slotMap) {
      const subjects = [...info.subjects];
      // 优先级：班会 > 自习 > 时段类型（班会、自习均不计入白课/晚自习）
      if (subjects.some(isClassMeetingSubject)) {
        classMeeting.add(key);
      } else if (subjects.some(isSelfStudySubject)) {
        selfStudy.add(key);
      } else {
        const ptype = periodType(info.periodLabel);
        if (ptype === 'morning') morning.add(key);
        else if (ptype === 'evening') evening.add(key);
        else day.add(key);
      }
    }
    const weeklyHours = slotMap.size;
    result.push({
      teacher,
      weeklyHours,
      monthlyHours: weeklyHours * 4,
      morningHours: morning.size,          // 早自习节数
      dayHours: day.size,                  // 白课(1-8)节数（不含班会、自习）
      eveningHours: evening.size,          // 晚自习节数（不含班会、自习）
      classMeetingHours: classMeeting.size,// 班会节数（科目为班会，无论时段）
      selfStudyHours: selfStudy.size,      // 自习节数（科目为自习，无论时段）
      classCount: teacherClasses.get(teacher).size,
      subjectCount: teacherSubjects.get(teacher).size,
      classes: [...teacherClasses.get(teacher)].sort(),
      subjects: [...teacherSubjects.get(teacher)].sort(),
      // 每日分布
      dailyDistribution: getDailyDistribution(entries, teacher)
    });
  }
  result.sort((a, b) => b.weeklyHours - a.weeklyHours);
  return result;
}

// 某教师每日课时分布
function getDailyDistribution(entries, teacher) {
  const dist = {};
  for (let wd = 1; wd <= 7; wd++) dist[wd] = 0;
  for (const e of entries) {
    if (e.teacher === teacher) dist[e.weekday] = (dist[e.weekday] || 0) + 1;
  }
  return dist;
}

// 班级课时统计
// 分别统计 早自习 / 白课(1-8) / 晚自习(晚1-晚4)
function classStatistics(entries) {
  const classMap = new Map();
  const classSlotsByType = new Map();
  for (const e of entries) {
    if (!e.class) continue;
    const key = `${e.weekday}|${e.period}`;
    const ptype = periodType(e.periodLabel);
    if (!classMap.has(e.class)) {
      classMap.set(e.class, new Set());
      classSlotsByType.set(e.class, { morning: new Set(), day: new Set(), evening: new Set() });
    }
    classMap.get(e.class).add(key);
    classSlotsByType.get(e.class)[ptype].add(key);
  }
  const result = [];
  for (const [cls, slots] of classMap) {
    const byType = classSlotsByType.get(cls);
    result.push({
      class: cls,
      weeklyHours: slots.size,
      morningHours: byType.morning.size,
      dayHours: byType.day.size,
      eveningHours: byType.evening.size
    });
  }
  result.sort((a, b) => b.weeklyHours - a.weeklyHours);
  return result;
}

module.exports = { teacherStatistics, classStatistics, WEEKDAY_NAMES };
