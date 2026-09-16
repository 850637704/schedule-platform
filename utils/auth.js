// 认证中间件

// 需要登录才能操作（上传/调课提交/撤销/删除数据）
function requireLogin(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: '请先登录', needLogin: true });
}

// 需要超管权限（账号管理）
function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.type === 'super') {
    return next();
  }
  return res.status(403).json({ error: '无权限，仅超级管理员可操作' });
}

// 获取当前登录用户（可为 null）
function getCurrentUser(req) {
  if (req.session && req.session.user) {
    return req.session.user;
  }
  return null;
}

// 获取当前用户的课表加载 ID
function getScheduleUserId(req) {
  const user = getCurrentUser(req);
  if (!user) return 'super';  // 未登录（教师）加载超管课表
  if (user.type === 'super') return 'super';
  return user.id;  // 管理员用自己的 ID
}

module.exports = {
  requireLogin,
  requireSuperAdmin,
  getCurrentUser,
  getScheduleUserId
};
