# 1.1.6 发布状态（2026-10-31）

本文件记录已上传的代码、尚未确认的生产条件和上线前的操作。`1.1.6` 是项目中紧接 `1.1.5` 的版本号；当前代码位于 `release/1.1.6` 分支，**尚未合入 `main`，也尚未部署为生产版本**。

## 已上传

- 教师端与教室端改动：`LY-Izar/shugao-teacher` 的 `release/1.1.6` 分支，首个提交 `3a9447b`。包含工作区导航、行政与班级页面、插件审核及只读授权、教师端插件结果、教室端实时数据刷新与写入队列、数据库结构和版本文案。
- 插件本体：`LY-Izar/shugao-plugins` 的 `main` 分支，提交 `efb5c6d`。插件仍以 Git 仓库中的程序和清单为来源；上传到仓库本身不等于管理员已审核或插件已在生产启用。
- `npm run build`、`npm run lint`、`nav-checks`、`rls-checks`、`admin-checks`、`exam-checks`、`backup-checks`、`grade-checks`、`ocr-checks`、`realtime-checks`、`plugin-framework-checks` 已在本地通过。权限检查使用本地 PostgreSQL 兼容测试库，并不能代替生产库验证。

## 已确认的问题

1. 生产 Supabase 尚未应用本分支的完整数据库结构。2026-10-31 用生产站点的只读接口查询 `plugin_sync_events` 得到 `404 / PGRST205`，说明新同步表目前不存在。新插件同步、教师端结果和新资料表不能据此宣称在线可用。
2. 完整浏览器截图检查 `npm run shots` 仍为红。脚本已适配学生档案权限和移除右侧「名单体检」的部分变化，但在「按身份显示导航」阶段仍查找旧桌面导航中的「考试」链接并中断。需要把这一节及后续检查改为现行的「今日概览 → 选择板块 → 目录 → 功能页」结构，再跑完整套截图检查。当前不能把前面已通过的页面当作整套检查通过。
3. `clock-checks` 的完整运行曾因旧演示数据数量断言失败；该断言已改为读取实际存档数量，`SHUGAO_ONLY_PASTE=1` 的对应节已通过。修正后尚未再次完成一次**不带早停参数**的完整运行。

## 尚未确认的生产条件

- 尚未取得生产 Supabase 的可用管理连接，因此 `supabase/schema.sql` 没有在目标项目实际执行，也未在生产身份下验证新增表、RLS、RPC 和 Realtime 事件。
- 尚未核对 Cloudflare Pages 的 `PLUGIN_REPO=LY-Izar/shugao-plugins`、只读 `PLUGIN_REPO_TOKEN`、Supabase 服务端地址及 `SUPABASE_SERVICE_ROLE_KEY` 是否正确配置。密钥不得写入 Git。当前生产站点的 `/api/plugins/bundle` 还不是本分支的新接口，须在部署后复核。
- 尚未用生产教师账号和教室端账号做端到端验证：插件 Git 更新无需重发包、管理员审核读表范围、插件结果同步到教师端、课表与校历即时刷新、断线后写入队列重放。
- 下载的插件通过 JavaScript 模块载入教室端页面。管理员审核是当前主要的信任边界；尚未完成恶意插件隔离审计，因此不能把「审核过的读表范围」表述为对任意恶意插件代码都有效的浏览器沙箱。

## 上线前操作顺序

1. 在 Supabase 目标项目 `gwdyiwopiymzqjnmkiou` 建立可验证的管理连接；先确认备份可用，再执行仓库中的 `supabase/schema.sql`，检查新增表、函数、RLS 和 Realtime 发布配置。整份脚本按可重复执行编写，本地 `rls-checks` 已覆盖；仍须以生产执行结果为准。
2. 核对 Cloudflare Pages 的生产变量与 Secret，尤其是插件 Git 仓库和只读访问令牌；保留服务端密钥在平台 Secret 中。
3. 修复并完整通过 `npm run shots`，完整复跑 `npm run clock-checks`；如改动了应用代码，再运行构建、lint 和受影响的逻辑检查。
4. 审核插件代码及其申请的读表范围；在管理端批准后，用真实教师与教室端账号验证读权限、结果同步、课表/校历刷新和断线重连。验证 Git 上更新插件后能直接生效。
5. 上述检查通过后再将 `release/1.1.6` 合入 `main`，等待 Cloudflare Pages 部署完成，核对线上版本号、页面、API 与数据库读写。保留可回退的上一版本和数据库备份。

## 当前阻碍

Supabase 连接工具返回 `Unknown tool`。尝试使用已登录的 Windows Edge 时，电脑控制的自动安全检查因无法可靠确定当前浏览器网址而拒绝操作；因此没有通过浏览器执行生产 SQL。要继续代操作，需要一个可被当前任务可靠识别的 Supabase 标签页或可用的 Supabase 项目连接；也可以由项目管理员在该项目 SQL 编辑器执行上述脚本并提供执行结果。
