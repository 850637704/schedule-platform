# 账号管理系统实现计划

## Context

课表管理平台当前无用户认证机制，所有访问者拥有相同权限。需要增加三级账号管理系统（超级管理员/管理员/教师），实现权限分级、数据隔离和登录认证。需求详见开发文档.md 第261行起的规划。

## 实现步骤

### 1. 安装依赖

```
npm install express-session crypto-js
```

不使用 bcrypt（需原生编译），改用纯 JS 的 `crypto-js`（SHA-256 哈希）。

### 2. 用户数据模块 `utils/userStore.js`（新建）

管理 `data/users.json`，数据结构：

```json
{
  "superAdmin": {
    "account": "17347363572",
    "passwords": ["<hash of 990322>"],
    "securityQuestion": "...",
    "securityAnswer": "<hash>"
  },
  "admins": [
    { "id": "xxx", "account": "...", "password": "<hash>" }
  ]
}
```

核心函数：
- `initUsers()` — 首次启动时创建默认超管账号，密码 `990322` 哈希存储
- `verifySuperAdmin(account, password)` — 校验超管密码（遍历 passwords 数组）
- `verifyAdmin(account, password)` — 校验普通管理员
- `addAdmin(account, password)` — 超管添加管理员
- `removeAdmin(id)` — 删除管理员及其课表数据
- `resetAdminPassword(id, newPassword)` — 重置管理员密码
- `addSuperAdminPassword(password)` — 超管新增密码
- `removeSuperAdminPassword(hash)` — 删除密码（不可删除 `990322`）
- `resetSuperAdmin()` — 重置超管为默认密码 `990322`
- 哈希函数：`crypto-js` SHA-256

### 3. 课表数据隔离 `utils/scheduleStore.js`（新建）

将 `data/schedule.json` 改为按用户存储：
- 超管课表：`data/schedule_super.json`
- 管理员课表：`data/schedule_<adminId>.json`
- 教师访问时加载超管课表

核心函数：
- `loadSchedule(userId)` — 按用户 ID 加载课表
- `saveSchedule(userId, data)` — 按用户 ID 保存课表
- `deleteSchedule(userId)` — 删除用户课表（删管理员时调用）
- `loadPublicSchedule()` — 教师访问，返回超管课表，不存在时返回 null

### 4. Session 中间件 `server.js` 修改

在 Express 初始化区域增加：
```js
const session = require('express-session');
app.use(session({
  secret: 'schedule-platform-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 2 * 60 * 60 * 1000 }  // 2小时过期
}));
```

### 5. 认证中间件 `utils/auth.js`（新建）

```js
function requireLogin(req, res, next)     // 需登录（上传/调课提交）
function requireSuperAdmin(req, res, next) // 需超管权限（账号管理）
function getCurrentUser(req)               // 获取当前用户（可为 null）
```

未登录时返回 `{ error: '请先登录', needLogin: true }`。

### 6. 后端 API 路由 `server.js` 修改

**新增路由：**
- `POST /api/login` — 登录（account + password），验证后存入 session
- `POST /api/logout` — 退出登录
- `GET /api/me` — 获取当前登录状态
- `GET /api/admin/accounts` — 获取管理员列表（仅超管）
- `POST /api/admin/accounts` — 添加管理员（仅超管）
- `DELETE /api/admin/accounts/:id` — 删除管理员（仅超管，同时删除课表数据）
- `PUT /api/admin/accounts/:id/password` — 重置管理员密码（仅超管）
- `POST /api/super/passwords` — 超管新增密码
- `DELETE /api/super/passwords/:hash` — 超管删除密码（990322 不可删）
- `POST /api/reset-super` — 隐藏接口，回答密保问题重置超管密码

**修改现有路由：**
- `POST /api/upload` — 加 `requireLogin` 中间件，保存时关联 userId
- `POST /api/swap/execute` — 加 `requireLogin` 中间件，操作自己课表
- `POST /api/swap/undo` — 加 `requireLogin` 中间件
- `DELETE /api/data` — 加 `requireLogin` 中间件
- `GET /api/*` 查询类路由 — 按 `getCurrentUser(req)` 加载对应用户课表（未登录加载超管课表）
- `loadData()` 替换为 `loadSchedule(userId)` 或 `loadPublicSchedule()`

### 7. 前端 `public/index.html` 修改

**上传区域右上角加登录按钮：**
```html
<div class="upload-header">
  <h1>上传课表</h1>
  <button id="login-btn" class="btn btn-outline">登录</button>
</div>
```

**新增账号管理 section（仅超管可见）：**
```html
<section id="view-accounts" class="view" style="display:none">
  <h1>管理账户</h1>
  <!-- 管理员列表 + 增删改 -->
</section>
```

**新增登录弹窗 modal：**
```html
<div id="login-modal" class="modal-overlay" style="display:none">
  <div class="modal-box">
    <h2>登录</h2>
    <input id="login-account" placeholder="账号">
    <input id="login-password" type="password" placeholder="密码">
    <button id="login-submit">确认登录</button>
    <button id="login-cancel">取消</button>
  </div>
</div>
```

**新增登出确认弹窗 modal：**
```html
<div id="logout-modal" class="modal-overlay" style="display:none">
  <div class="modal-box">
    <p>确定要退出登录吗？</p>
    <button id="logout-confirm">确认</button>
    <button id="logout-cancel">取消</button>
  </div>
</div>
```

### 8. 前端 `public/js/app.js` 修改

**全局状态新增：**
```js
let currentUser = null;  // { type: 'super'|'admin', account: '...' }
```

**页面加载时：**
- 调用 `GET /api/me` 获取登录状态
- 未登录：登录按钮显示"登录"，隐藏账号管理导航
- 已登录：按钮显示"超级管理员"/"管理员"，超管显示账号管理导航

**登录流程：**
- 点击"登录"按钮 → 弹出登录 modal
- 提交 → `POST /api/login` → 成功后关闭 modal，更新按钮和导航
- 失败 → toast 提示错误

**退出登录流程：**
- 点击身份按钮 → 弹出登出确认 modal
- 确认 → `POST /api/logout` → 更新 UI
- 取消 → 关闭 modal

**上传/调课拦截：**
- 上传时检查 `currentUser`，未登录则 toast "无权限，请先登录" 并弹出登录 modal
- 调课提交时同上，但允许查看候选

**账号管理视图（超管专属）：**
- 加载管理员列表
- 添加管理员表单（账号 + 密码）
- 删除管理员按钮（确认弹窗）
- 重置密码按钮
- 超管密码管理（增删密码，990322 标记不可删）

### 9. 前端 `public/css/style.css` 新增

- `.upload-header` — flex 布局，标题左对齐，登录按钮右对齐
- `.modal-overlay` — 全屏遮罩，居中弹窗
- `.modal-box` — 白色圆角弹窗
- 账号管理表格样式

### 10. 重置脚本 `reset-superadmin.js`（新建）

```js
const { resetSuperAdmin } = require('./utils/userStore');
resetSuperAdmin();
console.log('超管密码已重置为 990322');
```

运行方式：`node reset-superadmin.js`

## 关键文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `utils/userStore.js` | 新建 | 用户数据管理、密码哈希 |
| `utils/scheduleStore.js` | 新建 | 按用户隔离的课表数据存储 |
| `utils/auth.js` | 新建 | 认证中间件 |
| `reset-superadmin.js` | 新建 | 命令行重置脚本 |
| `server.js` | 修改 | Session、新路由、现有路由加权限 |
| `public/index.html` | 修改 | 登录按钮、弹窗、账号管理视图 |
| `public/js/app.js` | 修改 | 登录/登出/权限拦截/账号管理逻辑 |
| `public/css/style.css` | 修改 | 弹窗、登录按钮、账号管理样式 |
| `package.json` | 修改 | 新增 express-session、crypto-js |

## 验证方案

1. 首次启动：检查 `data/users.json` 自动创建，超管密码 `990322` 已哈希
2. 教师未登录访问：可查看课表、统计、冲突分析、调课候选；点击上传/提交调课时弹出登录提示
3. 超管登录：按钮显示"超级管理员"，侧边栏出现"管理账户"
4. 超管上传课表：教师能查看到超管的课表
5. 超管添加管理员 → 管理员登录 → 上传课表 → 两个课表互不可见
6. 超管删除管理员 → 该管理员课表数据一并删除
7. 退出登录：点击身份按钮弹出确认弹窗
8. `node reset-superadmin.js` → 超管密码重置为 `990322`
9. Session 过期后操作 → 弹出"登录已过期"提示
