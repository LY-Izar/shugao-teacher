-- ============================================================
--  树高教师平台 · Supabase 数据库结构
--
--  用法：Supabase 控制台 → SQL Editor → 新建查询 → 粘贴全文 → Run
--  可重复执行（全部是 if not exists / drop policy if exists）
--
--  安全模型：所有表开启 RLS，教师只能读写「自己」的数据。
--  前端只用 anon key；service_role key 绝不能出现在前端或仓库里。
-- ============================================================

-- ---------- 0. 扩展 ----------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ============================================================
--  1. 教师
-- ============================================================
create table if not exists teachers (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null default '',
  subject     text not null default '物理',
  school      text not null default '',
  created_at  timestamptz not null default now()
);

-- 注册后自动建一行 teachers
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.teachers (id, name, subject, school)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'subject', '物理'),
    coalesce(new.raw_user_meta_data ->> 'school', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ⚠️ 上面这版触发器**只认 `raw_user_meta_data ->> 'subject'`（显示名），学科一律兜底「物理」**。
--    多学科阶段 3（§13.1）会把它重定义成「能认 `subject_code`，写进 primary_subject_code」——
--    放在 §13 而不是这里，是因为它依赖 §12.3 那一列存在。
--    第 12 段跑之前，这一段保持原样是**故意**的：触发器出错会让**所有**新账号建不出来
--    （auth.users 的插入同事务回滚），所以改它必须带守卫（见 §13.1）。

-- ============================================================
--  2. 班级与学生
-- ============================================================
create table if not exists classes (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references teachers (id) on delete cascade,
  name        text not null,
  grade       text not null default '',
  year        text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists classes_teacher_idx on classes (teacher_id);

create table if not exists students (
  id          uuid primary key default gen_random_uuid(),
  class_id    uuid not null references classes (id) on delete cascade,
  student_no  text not null,
  name        text not null default '',
  -- active = 在读；left = 已转出（保留历史，不做物理删除）
  status      text not null default 'active' check (status in ('active', 'left')),
  created_at  timestamptz not null default now(),
  -- 学号是系统的唯一索引，班内不可重复
  unique (class_id, student_no)
);
create index if not exists students_class_idx on students (class_id);

-- ============================================================
--  3. 作业档案
--    收缴与批改都采用「只记例外」：默认全班已交 / 全对，只存例外的学号
-- ============================================================
create table if not exists assignments (
  id              uuid primary key default gen_random_uuid(),
  class_id        uuid not null references classes (id) on delete cascade,
  teacher_id      uuid not null references teachers (id) on delete cascade,
  title           text not null,
  subject         text not null default '物理',
  assign_date     date not null,
  question_count  int  not null default 1 check (question_count between 1 and 60),
  status          text not null default 'open'
                  check (status in ('open', 'collected', 'graded', 'reviewed', 'archived')),
  template_id     text,
  -- 收缴
  collected       boolean not null default false,
  missing_nos     text[]  not null default '{}',
  late_nos        text[]  not null default '{}',
  -- 批改：题号 -> 小题数；学号 -> 错题键数组（"3" 或 "3.1"）
  sub_questions   jsonb   not null default '{}'::jsonb,
  wrong           jsonb   not null default '{}'::jsonb,
  confirmed_nos   text[]  not null default '{}',
  grade_seconds   int,
  graded_at       timestamptz,
  -- 题号 -> 题型/分值/小问数/难度（从练习册 Word 稿识别而来，教师可改）
  question_meta   jsonb   not null default '{}'::jsonb,
  -- 'normal' 逐题记录；'simple' 只记优/良/差，没有逐题数据
  stats_mode      text    not null default 'normal',
  -- 极简模式：学号 -> 优/良/差
  grades          jsonb   not null default '{}'::jsonb,
  -- 本次作业的「需重点关注」学号（与改错名单是两回事）
  focus_nos       text[]  not null default '{}',
  -- 改错名单与已改错名单
  correction_nos  text[]  not null default '{}',
  corrected_nos   text[]  not null default '{}',
  created_at      timestamptz not null default now()
);
create index if not exists assignments_class_idx on assignments (class_id, assign_date desc);
create index if not exists assignments_teacher_idx on assignments (teacher_id);

-- 已经建过表的库补这些列（本脚本可重复执行）
-- ⚠️ `create table if not exists` 对**已存在**的表不会加列 —— 老库必须靠下面这几条 ALTER。
alter table assignments add column if not exists question_meta jsonb not null default '{}'::jsonb;
alter table assignments add column if not exists stats_mode     text    not null default 'normal';
alter table assignments add column if not exists grades         jsonb   not null default '{}'::jsonb;
alter table assignments add column if not exists focus_nos      text[]  not null default '{}';
alter table assignments add column if not exists correction_nos text[]  not null default '{}';
alter table assignments add column if not exists corrected_nos  text[]  not null default '{}';

-- ============================================================
--  4. 教师课表（每周重复）
-- ============================================================
create table if not exists schedule_items (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references teachers (id) on delete cascade,
  weekday     int  not null check (weekday between 1 and 7),   -- 1 = 周一
  start_time  time not null,
  end_time    time not null,
  title       text not null,
  class_id    uuid references classes (id) on delete set null,
  room        text,
  kind        text not null default 'class' check (kind in ('class', 'other')),
  notify      boolean not null default true,
  -- 'mine' = 教师自己的排课表；'class' = 班级课表（全班所有科目，给教室端看）
  scope       text not null default 'mine' check (scope in ('mine', 'class')),
  created_at  timestamptz not null default now()
);
create index if not exists schedule_teacher_idx on schedule_items (teacher_id, weekday);

-- 已经建过表的库补这一列（本脚本可重复执行）
alter table schedule_items add column if not exists scope text not null default 'mine';

-- ============================================================
--  5. 教室端与呼叫
-- ============================================================
create table if not exists classrooms (
  id            uuid primary key default gen_random_uuid(),
  teacher_id    uuid not null references teachers (id) on delete cascade,
  class_id      uuid not null references classes (id) on delete cascade,
  name          text not null default '',
  online        boolean not null default false,
  last_seen_at  timestamptz not null default now(),
  unique (class_id)
);

create table if not exists calls (
  id             uuid primary key default gen_random_uuid(),
  teacher_id     uuid not null references teachers (id) on delete cascade,
  assignment_id  uuid not null references assignments (id) on delete cascade,
  class_id       uuid not null references classes (id) on delete cascade,
  student_nos    text[] not null default '{}',
  text           text not null,
  room           text not null default '',
  -- 每次「再播一遍」追加一个时间戳
  sent_at        timestamptz[] not null default '{}',
  -- 学号 -> called | arrived | corrected
  states         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists calls_assignment_idx on calls (assignment_id, created_at desc);

-- ============================================================
--  6. 显式授权
--
--  创建项目时如果取消了「Automatically expose new tables」（推荐取消），
--  新建的表不会自动授权给任何角色 —— 而 **RLS 策略只在角色有表权限时才生效**，
--  光有 policy 没 GRANT，查询会直接报 permission denied。
--  所以这里手动授权。
--
--  为什么不干脆勾上「自动暴露」：自动暴露是 fail-open ——
--  以后加一张新表忘了配 RLS 就直接裸奔；
--  显式授权 + 显式 RLS 是 fail-safe —— 忘了配只是用不了，会立刻发现。
-- ============================================================

grant usage on schema public to anon, authenticated;

-- 登录教师：读写业务表（实际能看哪些行由下面的 RLS 决定）
grant select, insert, update, delete on
  teachers, classes, students, assignments, schedule_items, classrooms, calls
to authenticated;

-- 匿名用户：什么都不给。未登录不应读到任何业务数据。
revoke all on
  teachers, classes, students, assignments, schedule_items, classrooms, calls
from anon;

-- ============================================================
--  7. 行级安全（RLS）—— 每张表都要开，漏一张就等于全校数据裸奔
-- ============================================================
alter table teachers       enable row level security;
alter table classes        enable row level security;
alter table students       enable row level security;
alter table assignments    enable row level security;
alter table schedule_items enable row level security;
alter table classrooms     enable row level security;
alter table calls          enable row level security;

-- 教师：只能读写自己那一行
--  ⚠️ 这一条会被 §17.1 **重写**成三条逐动作策略（`teachers_self_select` /
--     `_insert` / `_update`），并加上"教室端不算教师"那一支。这里保留原文是为了
--     让 §7 这一段单独跑完时，行为与本文件历史版本**一字不差**。
drop policy if exists teachers_self on teachers;
create policy teachers_self on teachers
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- 班级：只能操作自己的班
drop policy if exists classes_own on classes;
create policy classes_own on classes
  for all to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid());

-- 学生：通过所属班级间接归属
drop policy if exists students_own on students;
create policy students_own on students
  for all to authenticated
  using (exists (select 1 from classes c where c.id = students.class_id and c.teacher_id = auth.uid()))
  with check (exists (select 1 from classes c where c.id = students.class_id and c.teacher_id = auth.uid()));

-- 作业档案
drop policy if exists assignments_own on assignments;
create policy assignments_own on assignments
  for all to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid());

-- 课表
drop policy if exists schedule_own on schedule_items;
create policy schedule_own on schedule_items
  for all to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid());

-- 教室端设备
drop policy if exists classrooms_own on classrooms;
create policy classrooms_own on classrooms
  for all to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid());

-- 呼叫记录
drop policy if exists calls_own on calls;
create policy calls_own on calls
  for all to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid());

-- ============================================================
--  8. 实时推送
--    教师端发出呼叫 → 教室端立刻收到（替代现在的 BroadcastChannel）
-- ============================================================
do $$
begin
  begin
    alter publication supabase_realtime add table calls;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table classrooms;
  exception when duplicate_object then null;
  end;
end $$;

-- 让 Realtime 的 UPDATE/DELETE 事件带上完整旧行，便于前端对账
alter table calls replica identity full;

-- ============================================================
--  9. 教师端 → 教室端 的文件互传
--
--  场景：教师把讲评要用的题图、答案 PDF、HTML、PPT 传上来，
--  教室一体机上直接打开或下载。
--  文件放 Supabase Storage 的**私有桶**，路径约定：
--    {teacher_id}/{uuid}-{原文件名}
--  这样存储策略只用路径第一段就能判断归属，不必额外查表。
--
--  ⚠️ 免费版存储只有 1 GB —— PPT 这类大文件要节制，
--     建议单文件 20 MB 以内，用完就删。
-- ============================================================
create table if not exists shared_files (
  id            uuid primary key default gen_random_uuid(),
  teacher_id    uuid not null references teachers (id) on delete cascade,
  -- 为空 = 所有班级可见；否则只给这个班
  class_id      uuid references classes (id) on delete cascade,
  name          text not null,
  mime          text not null default '',
  size          bigint not null default 0,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);
create index if not exists shared_files_teacher_idx on shared_files (teacher_id, created_at desc);

alter table shared_files enable row level security;
drop policy if exists shared_files_own on shared_files;
create policy shared_files_own on shared_files
  for all to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid());

grant select, insert, update, delete on shared_files to authenticated;
revoke all on shared_files from anon;

-- 私有桶（已存在就跳过）
insert into storage.buckets (id, name, public)
values ('classroom-files', 'classroom-files', false)
on conflict (id) do nothing;

-- 存储策略：只能读写自己目录下的文件
drop policy if exists classroom_files_read on storage.objects;
create policy classroom_files_read on storage.objects
  for select to authenticated
  using (bucket_id = 'classroom-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists classroom_files_insert on storage.objects;
create policy classroom_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'classroom-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists classroom_files_delete on storage.objects;
create policy classroom_files_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'classroom-files' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================
--  10. 权限与账号体系 · 阶段 1（建表 / 回填 / RLS 函数）
--      设计见 `权限与账号体系设计.md` §四 §五 §七 §九
--
--  ⚠️⚠️ 这一段的边界：**只做加法，一条旧策略都不动。**
--      旧策略仍然是 `teacher_id = auth.uid()`，所以跑完这段之后
--      现有功能的行为**完全不变** —— 新表、新函数只是躺在那里。
--      「用新策略替换旧策略」是阶段 5，是全流程唯一危险的一步，
--      必须先新旧并存、用真实账号核对可见数据量一致，才能删旧策略。
--
--  本段可重复执行（幂等）。
-- ============================================================

-- -------- 10.1 建表 --------

-- 学校（为将来多校预留，现在只有一所）
create table if not exists schools (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- 年级
create table if not exists grades (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references schools (id) on delete cascade,
  name       text not null,              -- 高一 / 高二 / 高三
  year       text not null default '',   -- 2026 级
  created_at timestamptz not null default now()
);
-- 同一所学校里年级名不重复（设计稿没写，但回填要幂等就需要它）
create unique index if not exists grades_school_name_key on grades (school_id, name);

alter table classes add column if not exists school_id uuid references schools (id);
alter table classes add column if not exists grade_id  uuid references grades (id);
create index if not exists classes_grade_idx on classes (grade_id);

-- 🔑 角色与管辖范围：一个人可以有多条（多角色是常态，不是异常）
create table if not exists teacher_roles (
  id         uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers (id) on delete cascade,
  role       text not null check (role in ('super','grade_head','head_teacher','admin','teacher')),
  -- 管辖范围：grade_head → grades；head_teacher → classes；super/admin → school 或 null
  scope_type text check (scope_type in ('school','grade','class')),
  scope_id   uuid,
  created_at timestamptz not null default now()
);
create index if not exists teacher_roles_teacher_idx on teacher_roles (teacher_id);
-- 同一人 + 同一角色 + 同一范围只允许一条。
-- scope_type/scope_id 可为 NULL，而唯一索引默认把 NULL 当互不相等 ——
-- 所以拿占位值把它们折叠起来，否则回填重跑会插出一堆重复行。
create unique index if not exists teacher_roles_unique on teacher_roles (
  teacher_id,
  role,
  coalesce(scope_type, ''),
  coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

-- 🔑 任课关系：谁教哪个班哪一科（这是「批改权限」的判据）
create table if not exists class_subjects (
  id         uuid primary key default gen_random_uuid(),
  class_id   uuid not null references classes (id) on delete cascade,
  subject    text not null,        -- 物理 / 语文 / …
  teacher_id uuid not null references teachers (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (class_id, subject, teacher_id)
);
create index if not exists class_subjects_teacher_idx on class_subjects (teacher_id);

-- 🔑 教室端账号：一个班一个，与登录账号一一对应（id = auth.uid()）
-- 与设计稿的两处偏差：
--  1. id 多了一条指向 auth.users 的外键。教室端账号是「先用管理员密钥建 auth 用户、
--     再写这一行」，外键成立；删掉 auth 用户时这行跟着走，不会留下
--     「指向已不存在的人、却依然授权」的残留。
--  2. 多存一列 email。教室端登录界面上要输「邮箱 + 密码」，而教师过几天回来
--     （换机器、重装、贴错密码）需要能重新看到这个邮箱 ——
--     不存的话就只能拿管理员密钥去 auth.users 里反查，既慢又要多一次管理员调用。
create table if not exists classroom_accounts (
  id         uuid primary key references auth.users (id) on delete cascade,
  class_id   uuid not null references classes (id) on delete cascade,
  school_id  uuid references schools (id),
  name       text not null,        -- 「高二(4)班教室」
  email      text not null default '',
  created_by uuid references teachers (id),
  disabled   boolean not null default false,
  created_at timestamptz not null default now(),
  unique (class_id)                -- 一个班只允许一个教室端账号
);

-- 新表同样要开 RLS：不开等于裸奔
alter table schools            enable row level security;
alter table grades             enable row level security;
alter table teacher_roles      enable row level security;
alter table class_subjects     enable row level security;
alter table classroom_accounts enable row level security;

-- 新表的读策略见 §10.4 —— 它要调用 visible_class_ids()，
-- 而 PostgreSQL 在 create policy 的那一刻就会解析表达式，
-- 所以函数必须先存在，策略不能写在这里。

-- -------- 10.2 回填现有数据（只增不改）--------
--  ⚠️ 回填**只做能确证的事**：学校、年级、班级归属、任课关系这些是数据事实；
--      **角色一律显式指派**（见 §10.6），不做任何推断式提权。
--  真实情况（用户 2026-09-24 确认）：教师有两位 —— 示例教师（高二(1)班 / 高二(4)班 的
--  **物理老师，不是班主任**）和一个测试账号；班级三个（含一个「测试专用」）。
--  设计 §七 里记的「示例教师一人 / 两个班 / 2 份作业」是 09-23 的快照，早已过时。

-- ① 学校：优先沿用 teachers.school 里已经填过的名字，没有才用默认
insert into schools (name)
select coalesce(
  (select nullif(school, '') from teachers where school <> '' limit 1),
  '示例中学'
)
where not exists (select 1 from schools);

-- ② 三个年级
insert into grades (school_id, name)
select s.id, g.name
from schools s
cross join (values ('高一'), ('高二'), ('高三')) as g(name)
on conflict do nothing;

-- ③ 班级挂到学校
update classes c
set school_id = s.id
from schools s
where c.school_id is null;

-- ④ 班级挂到年级：优先用 classes.grade；它是空的就从班名里抠「高X」
update classes c
set grade_id = g.id
from grades g
where c.grade_id is null
  and g.school_id = c.school_id
  and g.name = coalesce(nullif(c.grade, ''), substring(c.name from '^(高[一二三])'));

-- ⑤ 超管：**不回填**。
--    设计 §七 步骤 2 写的是「给现有教师插一条 role='super'」—— 那是 09-23 的假设，
--    当时以为库里只有示例教师一位教师、而且他就是管理员。
--    实际不是：示例教师只是任课教师，库里还有测试账号，真正的主管另有一个专用账号
--    （用户 2026-09-24 决定：**只留 Admin 一个最高管理员**）。
--    「按拥有班级的人自动提权」这条规则尤其危险：它会顺手把任何一个建过班的老师
--    变成全校可见 —— 那不是权限设计，那是漏洞。所以超管必须**显式指派**，见 §10.6。

-- ⑥ 班主任：**不回填**。
--    旧模型里 classes.teacher_id 的含义是「这条班级记录是谁建的」，
--    **不等于班主任** —— 本项目里示例教师是这两个班的物理老师，不是班主任
--    （用户 2026-09-24 明确）。设计 §七 步骤 3 里「班级所有者 = 班主任」是错的：
--    照它回填会让任课教师拿到班主任的实权。
--    ⚠️ 不要为了方便把它加回来 —— 这是权限，不是便利。
--    班主任同样必须按人显式指派，见 §10.6。

-- ⑦ 任课关系：班级所有者教自己那一科（示例教师 = 物理 × 两个班）
insert into class_subjects (class_id, subject, teacher_id)
select c.id, coalesce(nullif(t.subject, ''), '物理'), c.teacher_id
from classes c
join teachers t on t.id = c.teacher_id
on conflict do nothing;

-- -------- 10.3 RLS 函数 --------
--  核心手法（设计 §五）：把「能不能看到这个班」抽成一个函数，策略里只调它。
--  两个函数都是 security definer —— 以定义者身份读 teacher_roles，
--  避免「策略读表、表又触发策略」的套娃。

-- 与设计稿的差别：多加了 `set search_path = public`。
-- security definer 函数不锁 search_path 是可以被劫持的（搜索路径攻击），
-- 本文件里已有的 handle_new_user() 也是这么写的，保持一致。
-- 另外参数改名成 p_ 前缀，避免和列名同名带来的解析歧义（调用是按位置的，不受影响）。
--
-- 🔴 这里有一个**不能动的前提**：函数必须由表的属主（Supabase SQL 编辑器里就是 postgres）创建。
--    因为类的策略会调用 visible_class_ids()，而这个函数自己又读 class_subjects /
--    classroom_accounts / teacher_roles —— 一旦函数属主不是表属主，内层读取就会
--    重新触发策略 → 策略再调函数 → 无限递归。
--    表属主默认绕过 RLS，所以这条链是断的。**不要在 SQL 编辑器以外、用别的角色建这两个函数。**

-- 核心：给定一个人，他能看到哪些班。
-- 拆出 _for 变体的唯一理由是**可验证性**：SQL 编辑器里没有登录态，
-- auth.uid() 是 NULL，直接跑 visible_class_ids() 会一律返回 0 行 ——
-- 那样「新旧策略看到的数据量一致」的核对会得到 0 = 0 的**假通过**，
-- 而这恰恰是设计 §七「第 5 步是唯一危险步骤」的护栏。
-- 有了 _for，就能在编辑器里指定某个教师来核对。
--
-- 🔴 它接受任意 uid，等于「以任意人身份看班级」，所以**必须锁死**：
--    下面紧跟着 revoke，只留给属主（postgres）用。
--    新建函数默认对 PUBLIC 开放 EXECUTE，不 revoke 就等于任何教师
--    都能枚举别人的班级 —— 这条比什么都重要。
create or replace function visible_class_ids_for(p_uid uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  with me as (select p_uid as uid)
  select c.id
  from classes c
  where
    -- 最高管理员 / 行政：全校
    exists (select 1 from teacher_roles r, me
             where r.teacher_id = me.uid and r.role in ('super','admin'))
    -- 年级主任：本年级
    or exists (select 1 from teacher_roles r, me
                where r.teacher_id = me.uid and r.role = 'grade_head'
                  and r.scope_type = 'grade' and r.scope_id = c.grade_id)
    -- 班主任：本班
    or exists (select 1 from teacher_roles r, me
                where r.teacher_id = me.uid and r.role = 'head_teacher'
                  and r.scope_type = 'class' and r.scope_id = c.id)
    -- 任课教师：任教班（走班也走这条）
    or exists (select 1 from class_subjects cs, me
                where cs.teacher_id = me.uid and cs.class_id = c.id)
    -- 教室端：本班
    or exists (select 1 from classroom_accounts ca, me
                where ca.id = me.uid and ca.class_id = c.id and not ca.disabled);
$$;

revoke all on function visible_class_ids_for(uuid) from public, anon, authenticated;

-- 当前登录者能看到的班级 id 集合（策略里用的就是它）
create or replace function visible_class_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$ select * from visible_class_ids_for(auth.uid()) $$;

-- 能不能批改「这个班的这一科」
-- 注意：教室端**故意不在这里** —— 学生能碰到教室端那台机器，
-- 给教室端任何 assignments 的写权限都是破防（设计 §五 的红线）。
create or replace function can_grade(p_class_id uuid, p_subject text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with me as (select auth.uid() as uid)
  select
    exists (select 1 from teacher_roles r, me
             where r.teacher_id = me.uid and r.role in ('super','admin'))
    or exists (select 1 from teacher_roles r, me
                where r.teacher_id = me.uid and r.role = 'grade_head'
                  and r.scope_type = 'grade'
                  and r.scope_id = (select grade_id from classes where id = p_class_id))
    or exists (select 1 from teacher_roles r, me
                where r.teacher_id = me.uid and r.role = 'head_teacher'
                  and r.scope_type = 'class' and r.scope_id = p_class_id)
    or exists (select 1 from class_subjects cs, me
                where cs.teacher_id = me.uid and cs.class_id = p_class_id
                  and cs.subject = p_subject);
$$;

-- 注意：visible_class_ids_for() **故意不在这里 grant**（见上面的 revoke），
-- 它只给属主在 SQL 编辑器里做核对用。
grant execute on function visible_class_ids() to authenticated;
grant execute on function can_grade(uuid, text) to authenticated;

-- -------- 10.4 新表的读策略 --------
--  只给「读」，且都不越权：
--    schools / grades 的名字不算敏感
--    teacher_roles 只能读自己那一行（避免靠它反查别人的管辖范围）
--    class_subjects / classroom_accounts 按 visible_class_ids() 收口
--  注意：visible_class_ids() / can_grade() 是 security definer，
--  它们读 teacher_roles 时不走策略，所以这里不会「策略套策略」递归。
drop policy if exists schools_read on schools;
create policy schools_read on schools
  for select to authenticated using (true);

drop policy if exists grades_read on grades;
create policy grades_read on grades
  for select to authenticated using (true);

drop policy if exists teacher_roles_read on teacher_roles;
create policy teacher_roles_read on teacher_roles
  for select to authenticated using (teacher_id = auth.uid());

drop policy if exists class_subjects_read on class_subjects;
create policy class_subjects_read on class_subjects
  for select to authenticated using (class_id in (select visible_class_ids()));

drop policy if exists classroom_accounts_read on classroom_accounts;
create policy classroom_accounts_read on classroom_accounts
  for select to authenticated using (class_id in (select visible_class_ids()));

grant select on schools, grades, teacher_roles, class_subjects, classroom_accounts to authenticated;
revoke all on schools, grades, teacher_roles, class_subjects, classroom_accounts from anon;

-- -------- 10.5 「我是不是教室端」—— 这条判据的**唯一定义**（2026-09-25 补）--------
--  "我是不是教室端" = `classroom_accounts` 里有没有 id = 自己 uid 的那一行
--  （`classroom_accounts.id` 就是那个账号的 auth uid，见 §10.1 的说明）。
--
--  为什么要有这个函数（原来这条判据被手写了三遍）：
--    §10.3 的 visible_class_ids_for、§11.1 的 classrooms_heartbeat 与
--    schedule_classroom_write，都是同一句 `exists (select 1 from classroom_accounts …)`。
--    第四个调用方（§17 收紧两条裂缝）出现时，"教室端"这个身份在策略里就该只有一个名字——
--    否则口径一改（比如将来加"停用账号不算"）就是几处不一致。
--
--  🔴 这三条纪律都别改：
--    ① **`disabled` 不影响身份**：停用撤销的是访问范围（§11.1 的两条写策略各自判 `not disabled`），
--       不是"它是不是教室端"。这里多一个条件，停用的教室端就会掉回"教师"那一档 —— 正好相反。
--    ② **真正的老师恒为假**：老师不在 classroom_accounts 里 → 这个函数恒 false →
--       §17 的收紧对教师**一个字都不影响**（这是"别把真正的教师一起挡了"的落实）。
--    ③ **它必须在 §17 之前存在**：PostgreSQL 建策略时就会解析函数名，
--       "函数待会儿再建"在 `create policy` 这一步就报 `function … does not exist`
--       （真 PG 17 实测过，不是理论）。
create or replace function public.is_classroom_account()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from classroom_accounts ca where ca.id = auth.uid()
  );
$$;

grant execute on function is_classroom_account() to authenticated;

-- ⚠️ 教室里那台机器的安全边界靠这一条守：
--    绝不能给教室端账号任何 assignments 的 UPDATE 策略。
--    教室端的两个有限写权限（心跳 / 本班课表 scope='class'）留到阶段 3 ——
--    那时才有真账号可以验，现在加进去只是无法验证的攻击面。

-- -------- 10.5 阶段 2 的验证：把下面整段粘进 SQL 编辑器跑 --------
--  这是设计 §七「第 5 步是唯一危险步骤」的护栏：在删旧策略之前，
--  必须先证明新函数看到的数据 ⊇ 旧策略看到的数据。
--  用 visible_class_ids_for 指定人，所以**不必等前端登录** ——
--  直接写 visible_class_ids() 的话 auth.uid() 是 NULL，会得到 0 = 0 的假通过。

-- ① 回填体检：每一项都应该是 0
select '班级没挂到学校' as 检查项, count(*) as 应为0 from classes where school_id is null
union all
select '班级没挂到年级', count(*) from classes where grade_id is null
union all
select '教师没有角色', count(*) from teachers t
  where not exists (select 1 from teacher_roles r where r.teacher_id = t.id)
union all
select '有班级却没人任课', count(*) from classes c
  where not exists (select 1 from class_subjects cs where cs.class_id = c.id);

-- ② 回填明细
--    期望：1 所学校 / 3 个年级 / 3 个班 / **0 条 super、0 条班主任**（角色显式指派，见 §10.6）
--          / 3 行任课关系（示例教师 × 物理 × 高二(1)、高二(4)；测试账号 × 物理 × 测试专用）
select '学校' as 表, count(*)::text as 行数 from schools
union all select '年级', count(*)::text from grades
union all select '班级', count(*)::text from classes
union all select '角色-super', count(*)::text from teacher_roles where role = 'super'
union all select '角色-班主任', count(*)::text from teacher_roles where role = 'head_teacher'
union all select '任课关系', count(*)::text from class_subjects;

-- ③ 🔴 新旧策略对比（阶段 5 的放行条件）
--    把 uuid 换成要核对的教师 id（教师 id 用 select id, name, subject from teachers; 拿）
--    左右两组数**必须完全相等**，才允许进阶段 5 去删旧策略。
with me as (select '00000000-0000-0000-0000-000000000000'::uuid as uid)
select
  (select count(*) from classes  where id in (select visible_class_ids_for((select uid from me)))) as 新_班级数,
  (select count(*) from classes  where teacher_id = (select uid from me))                           as 旧_班级数,
  (select count(*) from students where class_id in (select visible_class_ids_for((select uid from me)))) as 新_学生数,
  (select count(*) from students s join classes c on c.id = s.class_id
     where c.teacher_id = (select uid from me))                                                      as 旧_学生数,
  (select count(*) from assignments where class_id in (select visible_class_ids_for((select uid from me)))) as 新_作业数,
  (select count(*) from assignments where teacher_id = (select uid from me))                          as 旧_作业数;

-- -------- 10.6 角色指派（模板，按真实的人换成实际语句）--------
--  🔴 **角色一律显式指派，绝不做推断式回填。**
--     曾经按「谁拥有班级谁就是班主任 / 谁建过班谁就是超管」回填过一次，
--     结果是：任课教师拿到了班主任的实权，建过班的测试账号被提成全校可见。
--     那不是权限设计，那是漏洞。
--
--  四种身份各自的判据（对应 §10.3 那两个函数）：
--    超管 / 行政   teacher_roles: role='super' / 'admin', scope_type='school'
--    年级主任      teacher_roles: role='grade_head',   scope_type='grade', scope_id=<grades.id>
--    班主任        teacher_roles: role='head_teacher', scope_type='class', scope_id=<classes.id>
--    任课教师      **不写 teacher_roles**，写 class_subjects（见 10.2 ⑦）——
--                  它只决定"能不能批改这一科"，**不代表班主任身份**
--
--  指派模板（把姓名和班名换成真实的）：
--
--  -- 设为最高管理员
--  insert into teacher_roles (teacher_id, role, scope_type, scope_id)
--  select t.id, 'super', 'school', (select id from schools order by created_at limit 1)
--  from teachers t where t.name = '某某'
--  on conflict do nothing;
--
--  -- 设为某班班主任
--  insert into teacher_roles (teacher_id, role, scope_type, scope_id)
--  select t.id, 'head_teacher', 'class', c.id
--  from teachers t, classes c
--  where t.name = '某某' and c.name = '高二(4)班'
--  on conflict do nothing;
--
--  -- 设为某年级主任
--  insert into teacher_roles (teacher_id, role, scope_type, scope_id)
--  select t.id, 'grade_head', 'grade', g.id
--  from teachers t, grades g
--  where t.name = '某某' and g.name = '高二'
--  on conflict do nothing;
--
--  -- 加一门任课关系（任课教师真正的身份在这里）
--  insert into class_subjects (class_id, subject, teacher_id)
--  select c.id, '物理', t.id
--  from teachers t, classes c
--  where t.name = '某某' and c.name = '高二(4)班'
--  on conflict do nothing;

-- ============================================================
--  11. 阶段 2：新策略与旧策略**并存**（只加，不删）
--
--  ⚠️ 这一步是「加策略」，不是「换策略」。
--     PostgreSQL 的 permissive 策略之间是 **OR** —— 新旧并存时可见范围是两者的**并集**。
--     已验证（用户实跑）：对示例教师，visible_class_ids_for() 与旧策略 teacher_id = auth.uid()
--     看到的**完全相等**（班级 2 / 学生 80 / 作业 8），所以这个并集就是原来那个集合 ——
--     教师的可见范围一点没变。这正是设计 §七 要求的"先并存核对，再删旧的"。
--
--  🔴 只有一类身份的可见范围是**净新增**的：教室端账号。
--     旧策略下它什么都看不到（teacher_id = auth.uid() 对它永远为假），
--     这里给它的读权限就是它该有的全部 —— 一个班一台机器，只看得见自己班。
--
--  旧策略**一条都不删**。删除是阶段 5，要等前端按角色分流做完、教室端真机验过。
-- ============================================================

-- 班级 / 学生 / 作业 / 呼叫：看得见这个班 → 看得见班里的东西
drop policy if exists classes_visible on classes;
create policy classes_visible on classes for select to authenticated
  using (id in (select visible_class_ids()));

drop policy if exists students_visible on students;
create policy students_visible on students for select to authenticated
  using (class_id in (select visible_class_ids()));

drop policy if exists assignments_visible on assignments;
create policy assignments_visible on assignments for select to authenticated
  using (class_id in (select visible_class_ids()));

drop policy if exists calls_visible on calls;
create policy calls_visible on calls for select to authenticated
  using (class_id in (select visible_class_ids()));

-- 课表：教室端要的只有「班级课表」这一类（scope='class'）。
-- 教师自己的排课表（scope='mine'）仍由旧策略负责，这条不碰它。
drop policy if exists schedule_class_visible on schedule_items;
create policy schedule_class_visible on schedule_items for select to authenticated
  using (scope = 'class' and class_id in (select visible_class_ids()));

-- 教室端设备行（在线状态）
drop policy if exists classrooms_visible on classrooms;
create policy classrooms_visible on classrooms for select to authenticated
  using (class_id in (select visible_class_ids()));

-- -------- 11.1 教室端的两处有限写（设计 §五）--------
--  ⚠️ 设计稿 §五 这里有个笔误，照它写会永远匹配不上：
--     原文是 `id in (select id from classroom_accounts where id = auth.uid())` ——
--     拿 classrooms.id（**设备行**的 id）去比 classroom_accounts.id（**教室端账号**的 auth uid），
--     这是两个不同的 uuid，条件恒为假。正确写法是按 **class_id** 关联。
--     另外补了 `not disabled` —— 停用的账号不该还能写。

-- ① 心跳
drop policy if exists classrooms_heartbeat on classrooms;
create policy classrooms_heartbeat on classrooms for update to authenticated
  using (class_id in (select class_id from classroom_accounts
                       where id = auth.uid() and not disabled))
  with check (class_id in (select class_id from classroom_accounts
                            where id = auth.uid() and not disabled));

-- ② 本班课表（粘贴 / 修改 scope='class' 的课）
drop policy if exists schedule_classroom_write on schedule_items;
create policy schedule_classroom_write on schedule_items for all to authenticated
  using (scope = 'class' and class_id in (select class_id from classroom_accounts
                                           where id = auth.uid() and not disabled))
  with check (scope = 'class' and class_id in (select class_id from classroom_accounts
                                                where id = auth.uid() and not disabled));

-- 🔴 绝不能给教室端账号任何 assignments 的 INSERT / UPDATE / DELETE 策略 ——
--    学生能碰到教室端那台机器，这是整个设计的安全边界。
--    上面 assignments 只加了 for select，写权限仍然只属于教师。

-- ============================================================
--  12. 多学科 · 阶段 1（学科字典 / subject_code 加列 / 回填）
--      设计见 `多学科体系方案.md` §3.0，前端见 `app/src/lib/subjects.ts`
--
--  ⚠️⚠️ 这一段的边界（与前两段同一个纪律）：
--    ① **只做加法**：一条旧策略都不动、一个旧列都不删。
--       `assignments.subject` / `teachers.subject` / `class_subjects.subject`
--       全部原样保留 —— 它们从此是「显示名」，`subject_code` 才是判据。
--    ② **不做破坏性迁移**：不加 not null、不改类型、不换 unique 约束、
--       不动 can_grade 的函数签名。`class_subjects` 的 unique 从
--       (class_id, subject, teacher_id) 换成 (class_id, subject_code, teacher_id)
--       是**第三阶段**（多学科协作）的事，那一步要连着写策略一起做。
--    ③ **回填只做能确证的**：学科名与字典的 `name` 去空白后**完全相同**才回填。
--       对不上的**留 null 并在 §12.5 报出来**，绝不 `coalesce(...,'物理')` ——
--       那样会把库里的异常值静默改写成物理，体检 SQL 永远是 0 行，"通过"是假的。
--    ④ 前端在**这一段还没跑**时必须照常工作（读：列读不到就按显示名反查；
--       写：探测到列不存在就不带这一列）—— 见 app/src/data/remote.ts 的 ensureSubjectCols()。
--       也就是说：先跑 SQL 还是先发前端，两种顺序都不会坏。
--
--  本段可重复执行（幂等）。
-- ============================================================

-- -------- 12.1 学科字典 --------
--  「15 个科目」在字典里是**数据**，不是代码里的 if ——
--  以后加一科（或学校改叫法）只需要往这张表插一行 + 前端 subjects.ts 补一行。
create table if not exists subjects (
  code       text primary key,          -- 'chinese' / 'math' / 'physics' …
  name       text not null,             -- 语文 / 数学 / 物理 …
  short      text not null default '',  -- 两个字短名，手机上用
  -- 走班候选：**只是字典里的一条数据**，界面入口是否打开由它决定
  can_stream boolean not null default false,
  sort       int  not null default 0,
  created_at timestamptz not null default now()
);

-- 字典的读权限：学科名不敏感，同 schools / grades 的做法（§10.4）
alter table subjects enable row level security;
drop policy if exists subjects_read on subjects;
create policy subjects_read on subjects
  for select to authenticated using (true);
grant select on subjects to authenticated;
revoke all on subjects from anon;

-- -------- 12.2 字典数据（15 行）--------
--  显示名 / 短名 / 顺序**由代码管**：重跑本段就同步（改文案不用手工改库）。
--  `can_stream`（走班候选）**冲突时不覆盖** —— 它是学校可以自己改的业务数据。
--  分工：代码管文案，学校管业务开关。
insert into subjects (code, name, short, can_stream, sort) values
  ('chinese',       '语文',     '语', false,  1),
  ('math',          '数学',     '数', false,  2),
  ('english',       '英语',     '英', false,  3),
  ('physics',       '物理',     '物', false,  4),
  ('chemistry',     '化学',     '化', false,  5),
  ('biology',       '生物',     '生', true,   6),
  ('politics',      '政治',     '政', true,   7),
  ('history',       '历史',     '史', false,  8),
  ('geography',     '地理',     '地', true,   9),
  ('it',            '信息技术', '信', false, 10),
  ('general_tech',  '通用技术', '通', false, 11),
  ('pe',            '体育',     '体', false, 12),
  ('music',         '音乐',     '音', false, 13),
  ('art',           '美术',     '美', false, 14),
  ('mental_health', '心理健康', '心', false, 15)
on conflict (code) do update
  set name = excluded.name, short = excluded.short, sort = excluded.sort;

-- -------- 12.3 加列（旧列一律留着）--------
--  用 `add column if not exists`：已经手工加过的库不会被重复折腾。
--  外键指向 subjects(code)：字典外的学科代码**写不进去**（这是好事 ——
--  前端只会送字典里的 code，见 lib/subjects.ts 的 asSubjectCode）。
--  ⚠️ 没有 `not null` 也没有默认值：这一列允许为空，因为总有回填不了的老数据，
--     而"空"必须能被看见（§12.5），不能被一个默认值盖住。
alter table assignments    add column if not exists subject_code text references subjects (code);
alter table teachers       add column if not exists primary_subject_code text references subjects (code);
alter table class_subjects add column if not exists subject_code text references subjects (code);

create index if not exists assignments_subject_idx on assignments (subject_code);

-- -------- 12.4 回填（只填能确证的）--------
--  判据：学科名与字典 name 去空白后完全相同。
--  说明：方案 §3.0.4 写的是三条只认 '物理' 的 UPDATE；这里写成**按字典连接**，
--  效果包含它，而且顺手覆盖了"已经有老师把学科改成化学、也建过作业"的情形 ——
--  仍然是精确匹配、仍然不猜（对不上的留 null 并报出来）。

-- ① 作业档案（`assignments.subject` 是显示名，抄进 subject_code 当判据）
update assignments a
set subject_code = s.code
from subjects s
where a.subject_code is null
  and btrim(a.subject) = s.name;

-- ② 教师的主学科。**注意它是从 `teachers.subject` 反查**，
--    改的是新列：`teachers.subject` 本身一个字都不改（它继续当显示标签）。
update teachers t
set primary_subject_code = s.code
from subjects s
where t.primary_subject_code is null
  and btrim(t.subject) = s.name;

-- ③ 任课关系：**以它自己的 `subject` 为准**，不看 teachers.subject。
--    这两者在旧模型里可能已经不一致（老师在设置页改过学科、而这里没跟着变），
--    任课关系是「谁教这个班这一科」的事实记录，必须以它自己那行为准。
update class_subjects cs
set subject_code = s.code
from subjects s
where cs.subject_code is null
  and btrim(cs.subject) = s.name;

-- -------- 12.5 自检（把下面整段粘进 SQL 编辑器跑）--------

-- ① 🔴 回填体检：**每一项都应该是 0**。
--    不为 0 说明库里有"字典外的学科字符串"（或空值）——这时**不要改脚本去凑**，
--    先看 ② 的明细，再按 §12.6 显式指派。留 null 是安全的：
--    前端读不到 code 会退回显示名，界面照常能用。
select '作业没有学科代码'   as 检查项, count(*) as 应为0 from assignments    where subject_code is null
union all
select '教师没有主学科',            count(*)        from teachers       where primary_subject_code is null
union all
select '任课关系没有学科代码',      count(*)        from class_subjects where subject_code is null;

-- ② 明细：字典外的学科字符串到底长什么样（上面全 0 时这一条返回 0 行）
select '作业' as 来源, a.subject as 学科名, count(*) as 行数
  from assignments a where a.subject_code is null group by 2
union all
select '教师', t.subject, count(*) from teachers t where t.primary_subject_code is null group by 2
union all
select '任课关系', cs.subject, count(*) from class_subjects cs where cs.subject_code is null group by 2
order by 1, 2;

-- ③ 字典本身（应该是 15 行；`can_stream = true` 的是走班候选）
select code, name, short, can_stream, sort from subjects order by sort;

-- ④ 回填前后对账：两个分组的行数应当**完全一致**
--    （`subject_code is null` 的那些行会在上面 ① 里被报出来，不会被藏起来）
select coalesce(a.subject, '(空)') as 学科名,
       count(*) as 总行数,
       count(a.subject_code) as 已有代码,
       count(*) filter (where a.subject_code is null) as 缺代码
  from assignments a group by 1 order by 2 desc;

-- -------- 12.6 主学科显式指派（模板，按真实的人换成实际语句）--------
--  老师自己在「我的 → 编辑」里能选主学科；这里是给"批量一次性理干净"和
--  "学科名字写得不是字典里的词"（例如「高中语文」）的老师用的。
--
--  -- 按字典名指派（把姓名和学科名换成真实的）
--  update teachers t set primary_subject_code = s.code
--  from subjects s
--  where s.name = '语文' and t.name = '某某';
--
--  -- 顺便把显示名也改成字典里的写法（可选，只影响观感）
--  update teachers t set subject = s.name
--  from subjects s where s.code = t.primary_subject_code and t.subject <> s.name;

-- -------- 12.7 这一段**不做**什么（免得后来的人以为漏了）--------
--  · `class_subjects` 的 unique 换列 → 第三阶段（要连着写策略一起做）
--  · `class_subjects` 的 insert/update/delete 策略 → 第三阶段
--     （今天前端写不进去，"谁教哪一科"仍然只能靠 SQL 维护）
--  · `can_grade()` 挂到策略上 → 第三/四阶段。**现在挂上去会让班主任
--     连作业都建不了**（没有对应动作的策略 = 该动作被拒）
--  · 删 `assignments.subject` / `teachers.subject` / `class_subjects.subject`
--     → 收口阶段；在体检连续为 0 之前不动它们
--  · 多学科知识树（PHYSICS_TREE 之外的第二棵树）→ 第二阶段

-- ============================================================
--  13. 多学科 · 阶段 3：建号带学科 + 身份判据 + 学科可见性分级
--      设计见 `权限与账号体系设计.md` §三（角色矩阵）§五（RLS）§六（账号创建）、
--      `多学科体系方案.md` §3.3；前端见 `app/src/lib/roles.ts`、
--      `app/src/pages/TeacherAccounts.tsx`、`app/functions/api/teacher-account.ts`
--
--  ⚠️⚠️ 这一段的边界（比前几段窄，请照着读）：
--    ① **只动「读」**：只重写 assignments 的 select 策略（13.4）。
--       写策略一条都不动 —— `assignments_own`（for all, teacher_id = auth.uid()）原样保留。
--       于是**自己建的档案永远看得见、改得动**，可见范围收缩不可能让谁丢数据。
--    ② **只收窄「别人的、别的学科的」**：班主任 / 年级主任 / 行政 / 最高管理员 / 教室端
--       仍然是「一个班的所有学科」（用户口径）。变窄的只有一种人：
--       **只教某一科的任课教师，看不到同班别的老师那一科**。
--    ③ 依赖第 12 段（`subject_code` 三列 + `subjects` 字典表）：**先跑第 12 段**。
--       整份脚本从头跑到尾当然没问题（幂等）；单独粘第 13 段则必须先有第 12 段。
--    ④ 前端在这一段还没跑时照常工作：可见范围是数据库收口的，前端读到几行就渲染几行，
--       不另写一套过滤（见 `功能设计与不变量.md` §11.3 / §12.7 I16）。
--
--  本段可重复执行（幂等）。
-- ============================================================

-- -------- 13.1 建号时把学科带进 teachers（触发器的第二阶段）--------
--  为什么要有这一段：老师账号一直是在 Supabase Dashboard 手工建的，而
--  `handle_new_user`（§1）只认 `raw_user_meta_data ->> 'subject'`、兜底「物理」——
--  于是**新老师第一次登录时，学科 chip 预选的是物理**（哪怕他是语文老师）。
--
--  三条写入路径，按"谁先起作用"排：
--    ① 建号的人（管理员界面 / Dashboard 的 User Metadata）给 `subject`（字典里的显示名）
--       → 触发器写进 `teachers.subject` → 前端 `teacherPrimarySubjectCode()` 按显示名反查字典
--       → **chip 预选正确**。这条路**不依赖第 12 段**，是最保底的一条。
--    ② 同时给 `subject_code` → 这里写进 `teachers.primary_subject_code`（判据那一列）。
--    ③ 管理员界面的建号走 `functions/api/teacher-account.ts`，它用 service_role
--       **自己再写一次** teachers 行（不看触发器版本）—— 所以界面建号不依赖这一段跑没跑。
--
--  🔴 为什么整段 update 包在异常里：触发器抛错 = **所有**新账号都建不出来
--     （auth.users 的插入与触发器同事务）。§12.3 的列还不存在时，
--     `undefined_column` 必须被吞掉 —— 宁可主学科先空着（前端有兜底），
--     也不能让建号这个动作整个坏掉。这与 §12 的"只做加法"是同一条纪律。
--
--  📌 在 Supabase Dashboard 里手工建号时，User Metadata 这样填就能带上学科
--     （`subject` 是**字典里的中文名**，`subject_code` 是代码；两个都给最稳）：
--       { "name": "李老师", "subject": "语文", "subject_code": "chinese" }
--     从教师端的「我的 → 教师账号」建号则不用管这些 —— 那条路走 §13.9 提到的
--     `functions/api/teacher-account.ts`，它自己会写。两科都教的话，
--     主学科填一科，另一科靠 `class_subjects`（它才是"看得见哪一科"的判据）。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text;
  v_subject text;
  v_code    text;
begin
  v_name := coalesce(
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'name', '')), ''),
    split_part(new.email, '@', 1)
  );
  -- 显示名：字典里的写法最好（前端读不到 primary_subject_code 时要按它反查字典）
  v_subject := coalesce(
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'subject', '')), ''),
    '物理'
  );
  v_code := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'subject_code', '')), '');

  insert into public.teachers (id, name, subject, school)
  values (new.id, v_name, v_subject, coalesce(new.raw_user_meta_data ->> 'school', ''))
  on conflict (id) do nothing;

  -- 主学科（判据列）：**只认字典里有的代码**，认不出来一律不写（不猜）
  if v_code is not null then
    begin
      update public.teachers t
      set primary_subject_code = s.code
      from public.subjects s
      where t.id = new.id and s.code = v_code;
    exception
      when undefined_column or undefined_table or invalid_schema_name then
        null;   -- 还没跑第 12 段：主学科先空着，前端按显示名反查
    end;
  end if;

  return new;
end;
$$;

-- -------- 13.2 身份判据：最高管理员 ≠ 行政老师 --------
--  用户口径：「最高管理员、行政老师是**不同身份**，权限要分开」。
--  现状：`admin` 这个名字在设计稿的角色清单里根本没有（§三 列的是 principal /
--  vice_principal / dean），SQL 里却一直写成 `role in ('super','admin')` 把两者当一回事 ——
--  所以要做的是**拆判据**，不是加角色名：`admin` 就是"行政老师"那一档。
--
--  本轮落地的差别（**这两个函数都真的有人调，不是摆设**）：
--    · 建教师账号 / 维护任课关系 / 重置密码 → super + admin（`can_manage_teachers()`）
--    · 指派身份（班主任 / 年级主任 / 行政 / 最高管理员）→ **只有 super**（`is_super_admin()`）
--    · 看全校教学数据（班级 / 学生 / 作业 / 呼叫）→ 两者都可以（设计 §三 已确认口径）
--  调用方是 `app/functions/api/teacher-account.ts`：它拿**调用者的 JWT** 走
--  `POST /rest/v1/rpc/<函数名>`（auth.uid() 就是调用者），而不是在 TypeScript 里重写规则。
--  service_role 绕过 RLS，所以"用管理员密钥代劳"的那条路必须以这两个函数为唯一判据。
--
--  ⚠️ 与 `visible_class_ids_for` 同样的锁：`_for` 变体接受任意 uid，
--     等于"以任意人身份问一句能不能管账号"，必须 revoke 掉，只留给属主核对用。
create or replace function public.is_super_admin_for(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from teacher_roles r
    where r.teacher_id = p_uid and r.role = 'super'
  );
$$;

create or replace function public.can_manage_teachers_for(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from teacher_roles r
    where r.teacher_id = p_uid and r.role in ('super', 'admin')
  );
$$;

revoke all on function is_super_admin_for(uuid)   from public, anon, authenticated;
revoke all on function can_manage_teachers_for(uuid) from public, anon, authenticated;

-- 当前登录者版本（界面与服务端都用它）
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select is_super_admin_for(auth.uid()) $$;

create or replace function public.can_manage_teachers()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_manage_teachers_for(auth.uid()) $$;

grant execute on function is_super_admin()     to authenticated;
grant execute on function can_manage_teachers() to authenticated;

-- -------- 13.3 学科可见性：谁看得见「这个班里的这一科」--------
--  用户口径（原话）：**学科教师只能看见自己所教的学科；班主任 / 年级主任能看见一个班的所有学科。**
--  拆成两个函数，各答一半 —— 「全科视角」和「本科视角」在读代码时一眼分得开：
--    can_view_all_subjects(class_id)                → 全科视角
--    teaches_subject(class_id, code, name)          → 本科视角（任课关系）
--  它们**都不是**"能不能看见这个班"的判据 —— 那是 `visible_class_ids()` 的活；
--  策略里两者是 and 关系（先看得见这个班，再谈看得见这一科），见 13.4。
--
--  🔴 教室端那一支（全科视角的最后一条）**不能少**：
--     教室端账号读 assignments 全靠这一条。少了它，教室里那块屏的
--     "逐题正确率 / 作业区"会整片变空，而且**不报错**（读不到行而已）。
--     它不是教师，没有 teacher_roles，也没有 class_subjects。
create or replace function public.can_view_all_subjects_for(p_uid uuid, p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- 最高管理员 / 行政老师：全校全科
    exists (select 1 from teacher_roles r
             where r.teacher_id = p_uid and r.role in ('super', 'admin'))
    -- 年级主任：本年级全科
    or exists (select 1 from teacher_roles r
                where r.teacher_id = p_uid and r.role = 'grade_head'
                  and r.scope_type = 'grade'
                  and r.scope_id = (select c.grade_id from classes c where c.id = p_class_id))
    -- 班主任：本班全科
    or exists (select 1 from teacher_roles r
                where r.teacher_id = p_uid and r.role = 'head_teacher'
                  and r.scope_type = 'class' and r.scope_id = p_class_id)
    -- 教室端：本班那块大屏
    or exists (select 1 from classroom_accounts ca
                where ca.id = p_uid and ca.class_id = p_class_id and not ca.disabled);
$$;

-- 我在这班教这一科吗？（任课关系是"能不能改这一科"的判据，也是"看得见哪一科"的判据）
--  两条路，**兼容期别删第二条**：
--    ① 新列：class_subjects.subject_code = 这份档案的学科代码
--    ② 老列：任课关系那行还没回填 subject_code 时（第 12 段没跑、或那行的学科名认不出来），
--       按**显示名精确比对** —— 与前端 `subjectCodeOf()` 的兜底是同一口径
--  这份档案的学科同样先看新列、再按显示名反查字典；
--  **认不出来就是 null → 不匹配 → 只留"自己建的"那条路**，绝不猜
--  （猜错会让一位老师的整科作业凭空消失，而且不报错）。
create or replace function public.teaches_subject_for(
  p_uid uuid,
  p_class_id uuid,
  p_subject_code text,
  p_subject text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with subj as (
    select coalesce(
      nullif(btrim(coalesce(p_subject_code, '')), ''),
      (select s.code from subjects s where btrim(s.name) = btrim(coalesce(p_subject, '')))
    ) as code
  )
  select exists (
    select 1
    from class_subjects cs, subj
    where cs.teacher_id = p_uid
      and cs.class_id = p_class_id
      and (
        (subj.code is not null and cs.subject_code = subj.code)
        or (cs.subject_code is null
            and btrim(cs.subject) = btrim(coalesce(p_subject, '')))
      )
  );
$$;

revoke all on function can_view_all_subjects_for(uuid, uuid) from public, anon, authenticated;
revoke all on function teaches_subject_for(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.can_view_all_subjects(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_view_all_subjects_for(auth.uid(), p_class_id) $$;

create or replace function public.teaches_subject(
  p_class_id uuid,
  p_subject_code text,
  p_subject text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select teaches_subject_for(auth.uid(), p_class_id, p_subject_code, p_subject) $$;

grant execute on function can_view_all_subjects(uuid) to authenticated;
grant execute on function teaches_subject(uuid, text, text) to authenticated;

-- -------- 13.4 作业档案的读策略（**本段唯一改权限的一步**）--------
--  旧：`class_id in (select visible_class_ids())`
--      —— 任课教师看得见本班**所有科目**的作业（学科维度等于没做）
--  新：自己建的 ∪ （看得见这个班 且 （全科视角 或 本科视角））
--
--  ⚠️ 为什么把「自己建的」显式写进策略：旧策略 `assignments_own`（for all）
--     今天仍然生效，所以这一句**今天是冗余的**；但收口阶段要删旧策略，
--     删掉之后 `teacher_id = auth.uid()` 就靠它兜住。
--     写在策略里，而不是靠"将来记得补"。
drop policy if exists assignments_visible on assignments;
create policy assignments_visible on assignments for select to authenticated
  using (
    teacher_id = auth.uid()
    or (
      class_id in (select visible_class_ids())
      and (
        can_view_all_subjects(class_id)
        or teaches_subject(class_id, subject_code, subject)
      )
    )
  );

-- ⚠️ 写策略**一条都不加**（这是有意的，别顺手补）：
--    · 现在生效的写判据是 `assignments_own`：`teacher_id = auth.uid()`。
--    · 想把 `can_grade()` 挂上来之前，必须先回答"班主任 / 年级主任能不能改成绩"
--      （设计 §三 的矩阵说**不能**，而 `can_grade()` 的函数体说**能** —— 两处自相矛盾）。
--      挂错了就是**权限事故**：班主任能改全科成绩。
--    · 反过来，往"写"上加策略只会**放宽**（策略之间是 OR），不可能收紧。
--      所以"学科教师只能改自己那一科"这件事，等 §5 收口时连着删 `assignments_own` 一起做。

-- -------- 13.5 核对：跑完这一段，先证明"没人丢自己的数据"（把下面整段粘进 SQL 编辑器）--------
--  这是本段的护栏，和第 10.5 ③ 是同一个套路：**用 `_for` 指定人**，
--  直接写 auth.uid() 的话 SQL 编辑器里是 NULL，会得到 0 = 0 的**假通过**。
--
--  ① 逐行对照（把 uuid 换成要核对的老师 id；教师 id 用 `select id, name from teachers;` 拿）
--     期望：**新_看得见 = false 的行，全部都是"他自己没建、也不教这一科"的**；
--           凡是 `teacher_id = 他自己` 的行，新_看得见必须是 true。
with me as (select '00000000-0000-0000-0000-000000000000'::uuid as uid)
select
  a.title                                        as 作业,
  c.name                                         as 班级,
  coalesce(a.subject_code, a.subject)             as 学科,
  a.teacher_id = (select uid from me)             as 是他建的,
  (select string_agg(cs.subject, '、')
     from class_subjects cs
    where cs.class_id = a.class_id and cs.teacher_id = (select uid from me))  as 他在本班任教,
  (a.class_id in (select visible_class_ids_for((select uid from me))))        as 旧_看得见,
  (a.teacher_id = (select uid from me)
     or (a.class_id in (select visible_class_ids_for((select uid from me)))
         and (can_view_all_subjects_for((select uid from me), a.class_id)
              or teaches_subject_for((select uid from me), a.class_id, a.subject_code, a.subject)))) as 新_看得见
from assignments a
join classes c on c.id = a.class_id
order by 4 desc, 6 desc, 2, 3;

--  ② 汇总：新 ≤ 旧 必须成立（交集只会变小）；"是他建的却新看不见"必须是 0
with me as (select '00000000-0000-0000-0000-000000000000'::uuid as uid),
     j as (
       select a.teacher_id,
              (a.class_id in (select visible_class_ids_for((select uid from me)))) as old_ok,
              (a.teacher_id = (select uid from me)
                or (a.class_id in (select visible_class_ids_for((select uid from me)))
                    and (can_view_all_subjects_for((select uid from me), a.class_id)
                         or teaches_subject_for((select uid from me), a.class_id, a.subject_code, a.subject)))) as new_ok
       from assignments a
     )
select
  count(*) filter (where old_ok)                                              as 旧_看得见,
  count(*) filter (where new_ok)                                              as 新_看得见,
  count(*) filter (where old_ok and not new_ok)                               as 被收窄,
  count(*) filter (where teacher_id = (select uid from me) and not new_ok)    as 自己建的却看不见_应为0
from j;

--  ③ 谁的身份是什么（跑完 13.2 之后，一眼看清 super 与 admin 各有几个人）
select t.name, t.subject, t.primary_subject_code, r.role, r.scope_type
from teacher_roles r join teachers t on t.id = r.teacher_id
order by r.role, t.name;

-- -------- 13.6 想退回旧读策略（一行，出问题时用）--------
--  drop policy if exists assignments_visible on assignments;
--  create policy assignments_visible on assignments for select to authenticated
--    using (class_id in (select visible_class_ids()));
--  退回去只会"看得更多"，不会让谁看不见东西 —— 所以这一步是安全的。

-- -------- 13.7 这一段**不做**什么（免得后来的人以为漏了）--------
--  · 挂 `can_grade()` 到写策略上 → 要先拍板"班主任 / 年级主任能不能改成绩"（见 13.4 的警告）
--  · 删 `assignments_own` 等旧策略 → 收口阶段（§5），且必须先并存核对
--  · `class_subjects` 的 unique 换列（(class_id, subject, teacher_id) → (class_id, subject_code, teacher_id)）
--  · 教室端账号的创建权限（`functions/api/classroom-account.ts` 里 `admin` 目前与 `super` 同等，
--    与设计 §三 矩阵不符）—— 那是教室端那条线，本轮刻意不动
--  · `teacher_roles` 的客户端写策略：指派身份只走服务端（`/api/teacher-account`），
--    数据库这一层只给"读自己那一行"（§10.4），**不 grant insert/update/delete** ——
--    免得同一个动作出现"前端直写"和"服务端代写"两个入口

-- ============================================================
--  14. 自检：确认每张表都开了 RLS
--     跑完应返回 0 行；返回任何一行都说明有表漏开
-- ============================================================
-- select tablename from pg_tables
--  where schemaname = 'public' and rowsecurity = false;

-- ============================================================
--  15. 考试（2026-09-27 新增）
--      设计见 `功能设计与不变量.md` §十四「考试」
--
--  🔴 两条与作业**故意相反**的约定（别把它们统一）：
--     ① 作业：默认全对，只记例外（`assignments.wrong`）；
--        考试：**默认全零**，没批改过的人每题 0 分。
--     ② 作业：收缴与批改都"只记例外"；考试要存**每个人的逐题数据**，
--        因为"0 分"与"还没批"必须分得开。
--
--  两张表：
--    `exams`        = 一次考试（一张卷子 × 一个班 / 一个年级）
--    `exam_scores`  = 一个学生的一次考试（逐题得分 + 选项 + 缺考）
--
--  ⚠️ **这一段是本仓库第一次给"成绩"单独立表**，所以写权限收得比作业紧：
--     作业那套写判据是 `teacher_id = auth.uid()`（谁建的谁能改）。
--     考试在这里更进一步：**写必须"在本班教这一科"**（`teaches_subject`），
--     光"建过这个班"不够 —— 用户口径：
--       「一个老师即使同时是年级主任/班主任，他能改的仍限于自己任教的班级+对应任教科目」
--     所以年级主任 / 班主任对别人的班**只能读**（这一条与设计 §三 矩阵一致：
--     成绩由学科老师上传和修改，年级主任和班主任都只能看）。
--
--  本段可重复执行（幂等）；前端在**这一段没跑过**时不许崩（见 §15.6）。
-- ============================================================

-- -------- 15.1 建表 --------

create table if not exists exams (
  id             uuid primary key default gen_random_uuid(),
  -- 谁建的（回退用；真正的写判据是"在本班教这一科"，见 15.3）
  teacher_id     uuid not null references teachers (id) on delete cascade,
  title          text not null,
  -- 归一化后的试卷键（前端 lib/examPaper.ts 的 normalizePaperName）。
  -- **同场考试的判定读它**，不读 title —— 否则每次判定都要重算，
  -- 而且历史档案的判定结果会随归一化规则改动而悄悄改变。
  paper_key      text not null default '',
  -- 学科：code 是判据、subject 是显示名（与 assignments 同一条纪律，§12.2）
  subject        text not null default '',
  subject_code   text references subjects (code),
  -- 'class' 班级考试（只记本班）/ 'grade' 年级考试（同名同科的档案一起排名）
  scope          text not null default 'class' check (scope in ('class', 'grade')),
  -- 年级（高一/高二/高三）：年级考试按它 + paper_key 把各班的档案合起来
  grade          text not null default '',
  -- 数据来源：'file' 平台文件导入 / 'manual' 手动批阅（智学网留空，这一轮不做）
  source         text not null default 'manual' check (source in ('file', 'manual')),
  -- 'answers' 记录答题情况（选择题按 m/n 判分）/ 'scores' 只记录分值
  mode           text not null default 'scores' check (mode in ('answers', 'scores')),
  exam_date      date not null,
  question_count int  not null default 1 check (question_count between 1 and 60),
  -- 题号 -> { kind, fullScore, answer, points, stem }
  questions      jsonb not null default '{}'::jsonb,
  -- 计划参加考试的班级（年级考试 = 同一年级多个班；班级考试通常一个）。
  -- 用数组而不是单列：一次年级考试里，一个老师可能同时教这个年级的两个班。
  class_ids      uuid[] not null default '{}',
  -- 缺考 / 未交学号（**只记例外**，与作业同一条纪律）
  absent_nos     text[] not null default '{}',
  status         text not null default 'grading' check (status in ('grading', 'graded')),
  graded_at      timestamptz,
  note           text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists exams_paper_idx  on exams (paper_key, subject_code, grade);
create index if not exists exams_class_idx  on exams using gin (class_ids);
create index if not exists exams_teacher_idx on exams (teacher_id, exam_date desc);

create table if not exists exam_scores (
  id          uuid primary key default gen_random_uuid(),
  exam_id     uuid not null references exams (id) on delete cascade,
  class_id    uuid not null references classes (id) on delete cascade,
  -- 学号即身份（与作业同一套：收缴/批改全以学号为键，§一）
  student_no  text not null,
  -- 姓名快照：学生转班/改名后，历史档案里仍要显示当时的名字
  name        text not null default '',
  -- 逐题得分：题号 -> 分数（answers 模式下只对非选择题用）
  scores      jsonb not null default '{}'::jsonb,
  -- 逐题选项：题号 -> 学生选的选项串（只有 answers 模式的选择题会写）
  answers     jsonb not null default '{}'::jsonb,
  -- 🔴 只有教师明确点过「确认批阅」才为 true（不变量 E1）
  graded      boolean not null default false,
  -- 缺考 / 未交：不参与均分（与"没批改"是两回事，后者按 0 分参与）
  absent      boolean not null default false,
  -- 文件带来的、或平台算出来的汇总。**文件里有就保留文件的值**（用户口径：不覆盖）
  total       numeric(7,2),
  objective   numeric(7,2),
  subjective  numeric(7,2),
  class_rank  int,
  grade_rank  int,
  created_at  timestamptz not null default now(),
  unique (exam_id, student_no)
);
create index if not exists exam_scores_exam_idx  on exam_scores (exam_id);
create index if not exists exam_scores_class_idx on exam_scores (class_id, student_no);

alter table exams       enable row level security;
alter table exam_scores enable row level security;

-- -------- 15.2 写判据：**在这份档案的某个班里教这一科** --------
--  为什么不能照抄作业的 `teacher_id = auth.uid()`：
--    用户口径是「能改的限于自己任教的班级 + 对应任教科目」，
--    而"建过这个班/建过这次考试"与"在这班教这一科"是两件事
--    （本仓库已经因为这两件事共用一个字段出过事故，见 §12.2 的教训）。
--
--  为什么"任一班"就够：班级考试只有一个班；年级考试里老师只会给自己那几个班录分，
--    别的班的分数由**那个班的任课老师**自己录 —— 一次考试是多人协作的，
--    这恰恰是"年级排名"能成立的原因。
--
--  兼容期两条路（与 §13.3 的 teaches_subject_for 同一口径）：
--    ① 新列：class_subjects.subject_code = 这份档案的学科代码
--    ② 老列：任课关系那行还没回填 subject_code 时，按**显示名精确比对**
--    **认不出来 = 不匹配**（不猜）。猜错会让一位老师改不了自己班的成绩，而且不报错。
--  🔴 两件套（2026-09-27 补 `_for` 变体，与 §16.2 全部判据同一套写法，见 §18）：
--    `can_edit_exam_for(uid, class_ids, code, name)` ← **函数体在这里**：显式传人，
--       给 SQL 编辑器核对与 `npm run rls-checks` 用 —— 所以它必须 **revoke**（§16.2）。
--    `can_edit_exam(class_ids, code, name)`          ← 读 `auth.uid()` 的薄包装，
--       **签名一个字没改**（§15.3 的策略引用着它，改签名要连带改策略）。
--  ⚠️ 两者顺序不能倒：PostgreSQL 在 `create function` 那一刻就解析 SQL 函数体，
--     薄包装若引用一个还没建的函数，会当场 `function … does not exist`
--     （PGlite / 真 PG 17 实测，见 §18.4）—— 所以定义只能在这里，不能挪到 §18。
--  ⚠️ 多班数组的语义：`any` —— **只要有一个班我教这一科就算能改**（不是"每个班都要我教"）。
--     为什么：班级考试只有一个班；年级考试是多人协作，别的班的分数由那个班的任课老师自己录
--     （上面的"为什么任一班就够"）。这条语义钉在 §18.2，回归钉在 rls-checks 第十三节。
create or replace function public.can_edit_exam_for(
  p_uid uuid,
  p_class_ids uuid[],
  p_subject_code text,
  p_subject text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with subj as (
    select coalesce(
      nullif(btrim(coalesce(p_subject_code, '')), ''),
      (select s.code from subjects s where btrim(s.name) = btrim(coalesce(p_subject, '')))
    ) as code
  )
  select
    -- 最高管理员兜底（与 can_grade 的 super/admin 一支同口径：两人一起，见 §13.1）
    --   ⚠️ 这里**不能**改调 is_school_admin_for()：它在 §16.2，比本段晚 ——
    --      建函数时就解析（同上面的告警），调用会当场报 does not exist。
    --      口径与那个函数逐字相同（I17 的已知重复处，§18.4 记了一笔）：改动时两处一起改。
    exists (select 1 from teacher_roles r
             where r.teacher_id = p_uid and r.role in ('super', 'admin'))
    -- 或者：在我教这一科的**某个**班里（任一班命中即可 —— 上面的多班语义）
    or exists (
      select 1
      from class_subjects cs, subj
      where cs.teacher_id = p_uid
        and cs.class_id = any (coalesce(p_class_ids, '{}'::uuid[]))
        and (
          (subj.code is not null and cs.subject_code = subj.code)
          or (cs.subject_code is null
              and btrim(cs.subject) = btrim(coalesce(p_subject, '')))
        )
    );
$$;

revoke all on function can_edit_exam_for(uuid, uuid[], text, text) from public, anon, authenticated;

create or replace function public.can_edit_exam(
  p_class_ids uuid[],
  p_subject_code text,
  p_subject text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_edit_exam_for(auth.uid(), p_class_ids, p_subject_code, p_subject) $$;

grant execute on function can_edit_exam(uuid[], text, text) to authenticated;

-- -------- 15.3 策略 --------
--  读：**看得见这个班就能读这次考试**（哪怕不是自己教的科）。
--     年级主任看整个年级的统计（用户口径）靠的就是这一条；
--     班主任看本班各科成绩同理。读得宽、写得窄 —— 与设计 §三 矩阵一致
--     （「看成绩」列比「上传/修改成绩」列宽）。
--
--  ⚠️ 为什么读策略不照抄 §13.4 的 `assignments_visible`（那条把学科也收窄了）：
--     作业是"我这一科的作业"，收窄学科是对的；
--     考试是**整个年级同一张卷子**，收窄了就算不出年级排名与班级排名 ——
--     而"排年级排名和班级排名"正是用户对这一段的原话要求。
drop policy if exists exams_visible on exams;
create policy exams_visible on exams for select to authenticated
  using (class_ids && (select array(select visible_class_ids())));

drop policy if exists exams_write on exams;
create policy exams_write on exams for all to authenticated
  using (
    teacher_id = auth.uid()
    and can_edit_exam(class_ids, subject_code, subject)
  )
  with check (
    teacher_id = auth.uid()
    and can_edit_exam(class_ids, subject_code, subject)
  );

drop policy if exists exam_scores_visible on exam_scores;
create policy exam_scores_visible on exam_scores for select to authenticated
  using (class_id in (select visible_class_ids()));

drop policy if exists exam_scores_write on exam_scores;
create policy exam_scores_write on exam_scores for all to authenticated
  using (
    exists (
      select 1 from exams e
      where e.id = exam_scores.exam_id
        and e.teacher_id = auth.uid()
        and can_edit_exam(e.class_ids, e.subject_code, e.subject)
    )
  )
  with check (
    exists (
      select 1 from exams e
      where e.id = exam_scores.exam_id
        and e.teacher_id = auth.uid()
        and can_edit_exam(e.class_ids, e.subject_code, e.subject)
    )
  );

--  ⚠️ exam_scores 的写策略里**再查一次 exams.teacher_id**，看起来冗余（exams_write 已经查过），
--     但它防的是这一种情形：A 老师建的考试，B 老师（同班同科）想直接往 exam_scores 插分。
--     今天的口径是"谁建的考试谁录分"（用户：科任老师改自己任教班级+科目），
--     所以 B 老师应当**自己建一份**同 paper_key 的档案 —— 前端的"同场考试"判定会
--     把两份档案合起来排名（见 §15.5 的核对 SQL）。这样两边的数据各归各，谁也不覆盖谁。
--
--  ⚠️ 教室端**故意一条写策略都没有**：那块屏是给学生看的（设计 §五 红线）。
--     读这一侧**刻意留着**：`exams_visible` 用的是 `visible_class_ids()`，教室端在里面
--     （"教室端只看得见自己那个班"，§10.3），所以它**读得到本班的考试档案与分数行**。
--     这是**有意为之**，不是漏了收：教室里那块屏将来要展示"本次考试逐题正确率"，
--     数据层先把这个口子留着（界面还没做，见 14.7 / 15.7 的"没做"清单）。
--     🔴 红线在**写**那一半：`exams_write` / `exam_scores_write` 逐条要求
--     `teacher_id = auth.uid()` + `can_edit_exam(...)`，教室端两边都不满足，
--     所以它**改不了任何考试数据**（读得到、写不了）。
--     ⚠️ 别"顺手"把它读的那一半也收掉：收了之后教室端的考试展示会**整片变空且不报错**，
--     而这条口径是 2026-09-27 拍过板的（`功能设计与不变量.md` §14.7 写的是同一句话）——
--     两边要一起改，改之前先读那一条。

grant select, insert, update, delete on exams       to authenticated;
grant select, insert, update, delete on exam_scores to authenticated;
revoke all on exams, exam_scores from anon;

-- -------- 15.4 自检（跑完这一段，把下面整段粘进 SQL 编辑器）--------
--  ① 两张表都开了 RLS、策略数量对不对
-- select tablename, rowsecurity from pg_tables
--  where schemaname = 'public' and tablename in ('exams','exam_scores');
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename in ('exams','exam_scores') order by 1,2;
--  期望：exams 2 条（visible=SELECT / write=ALL）、exam_scores 2 条，共 4 条。

--  ② 写判据函数在真实数据上的表现（把 uuid 换成要核对的老师 id）
-- with me as (select '00000000-0000-0000-0000-000000000000'::uuid as uid)
-- select t.name, cs.subject, cs.subject_code, c.name as 班级,
--        can_edit_exam_for((select uid from me), array[c.id], cs.subject_code, cs.subject) as 他能改
-- from class_subjects cs
-- join classes c on c.id = cs.class_id
-- join teachers t on t.id = cs.teacher_id
-- order by 1, 4;
--  期望：**`me` 自己任教的那几行是 true**；别人任教的班（同一个年级）是 false。
--   ✅ `can_edit_exam_for` 这个变体从 2026-09-27 起**已建**（§15.2，紧挨在薄包装之前），
--      上面这条可以原样粘着跑。此前它不存在，只能用
--      `is_school_admin_for(...) or teaches_subject_for(...)` 临时等价改写（§18.1 记了这段历史）。
--   ⚠️ 第一个参数是**数组**（考试可以多班）：`array[c.id]`；别照 §16.6 的标量写法抄成 `c.id`。
--
--  🔴 读这条结果时最容易搞错的一点（2026-09-27 用户实测踩到，记下来）：
--     前四列（`t.name` / `cs.subject` / `cs.subject_code` / 班级）说的是**这一行是谁的**，
--     最后一列 `他能改` 说的是 **`me`（核对对象）能不能改这一行** —— 这是两件事。
--     所以 `me` = 示例教师时看到 `demo-teacher / 物理 / 测试专用 = false`，它的意思是
--     "**示例教师**改不了 demo-teacher 那一行"（正确），**不是**"demo-teacher 改不了自己的班"。
--     要问后者就得判**每一行自己的老师**（§16.6 ② 的问法：`…_for(t.id, c.id, …)`），
--     两者在同一批数据上的实测对照记在 rls-checks 第十三节。
--  ⚠️ 另一个会把这条读成"全 false"的坑：`me` 按姓名查不到人 → CTE 是空集 →
--     依赖它的判据**全部**为 false（假失败）。所以先跑自检.sql 第 3 段开头那句「人是谁」。

-- -------- 15.5 年级排名怎么算（**没有额外的表，靠这一条查询**）--------
--  用户口径：「年级考试 → 按学科把整个年级同一场考试的数据读出来，排年级排名和班级排名」。
--  同一场考试的判据是 **paper_key + subject_code + grade + exam_date**，
--  这四样都在 exams 上，所以年级排名不需要"先建一次年级考试再把各班挂上去"这种结构 ——
--  每个班的任课老师各建各的档案，读的时候按上面四样合起来就是一次年级考试。
--
--  班级排名：班内按总分排名；年级排名：把那四样相同的所有班的分合起来排名。
--  下面这条是"排出来的名次长什么样"的核对 SQL（把 paper_key 换成真实值）：
-- with same_paper as (
--   select e.id, e.title, e.paper_key, e.exam_date, e.class_ids
--   from exams e
--   where e.scope = 'grade' and e.paper_key = '物理练习8'
-- )
-- select s.class_id, s.student_no, s.name, s.total,
--        rank() over (partition by s.class_id order by s.total desc nulls last) as 班级排名,
--        rank() over (order by s.total desc nulls last)                      as 年级排名
-- from exam_scores s
-- join same_paper p on p.id = s.exam_id
-- where not s.absent
-- order by 年级排名;

-- -------- 15.6 这一段跑之前，前端会怎样（"SQL 没跑也不崩"）--------
--  与 §12.4 / §13.6 同一套纪律，落在 `app/src/data/remote.ts` 的 `ensureExamTables()`：
--    · 探测：`select('id').limit(1)` 打两张表，判据只有「表不存在」这一种错误
--      （`42P01` / `PGRST205` / `does not exist`）；
--    · 读：表不在 → 返回空数组，考试列表显示"还没有考试档案"，**不白屏**；
--    · 写：表不在 → **不写**，返回一条"请先跑 schema.sql 第 15 段"的提示
--      （而不是乐观更新后刷新即丢 —— 复习 §一「保存失败 = 刷新即丢」）；
--    · 探测只看「表不存在」：网络抖动/权限问题**一律当作有**，免得一次抖动把写永久停掉。
--
-- -------- 15.7 这一段**不做**什么（免得后来的人以为漏了）--------
--  · 智学网数据源 —— 用户明确"先留空，这轮不做"
--  · 走班教学班（`teaching_groups`）—— 用户明确"先做行政班多选，走班留接口、不要猜"；
--    `exams.class_ids` 是数组，将来加 `teaching_group_ids` 是纯加法
--  · 考试与作业的统计合并 —— 两者的默认值正好相反（全零 vs 全对），合并一定算错
--  · 教室端的考试展示 —— 本轮只做教师端；数据层已经允许教室端读（见 15.3 的说明），
--    界面留到下一轮

-- ============================================================
--  16. 收口 · 阶段 5：逐表写策略矩阵 + can_grade 落地 + 删旧策略
--      设计见 `权限与账号体系设计.md` §三（角色矩阵）§五（RLS）§九（阶段 5）、
--      `多学科体系方案.md` §3.3.3 与 §5「阶段 5」；
--      `功能设计与不变量.md` §十六 记的是"为什么这样写"。
--
--  🔴🔴 这是全仓库**唯一不可逆**的一段：它删掉 §7 那批 `for all` 旧策略（见 16.4）。
--      为什么必须先补全写策略、再删旧的：PostgreSQL 里
--      「**没有对应动作的策略 = 该动作被拒**」。
--      照原样只留 §11 §13 的 `for select` 就删旧策略，
--      **新建作业 / 批改 / 加学生会被 RLS 直接拒掉**，而界面上看不出来
--      （乐观更新先改本地，失败只进 `syncError`，"保存失败 = 刷新即丢"）。
--      顺序：① 判据函数（16.2）② 逐表写策略矩阵（16.3）③ 删旧策略（16.4）
--      ④ 跑 16.6 的核对 SQL，证明"没人丢数据、该拒的确实被拒"。
--
--  📌 用户 2026-09-27 拍板的口径（照它写，不要自己发挥）：
--      建班 / 加删学生    super · admin(教导处) · grade_head(本年级) · head_teacher(本班)
--      建作业档案         任课老师（自己任教的班 + 那一科）；super / admin 兜底
--      删作业档案         任课老师（自己任教的班 + 那一科）· 管理身份按各自范围 · 自己建的
--      改成绩 / 批改      **只有该班该科的任课老师**；班主任 / 年级主任**只读**
--                        （super / admin 兜底：设计 §三 矩阵 + 第 15 段考试同一口径）
--      教室端账号         只读（两处有限写不变：心跳 + 本班班级课表）
--      指派身份           教导处(admin) + 最高管理员(super)  ← 与 §13.1 那张表**不同**，见 16.7
--
--  ⚠️ 实测发现（它决定了下面策略的写法，别把这些注释当废话删掉）：
--     前端所有保存都走 **upsert**（`remote.ts` 的 `upsert()` → PostgREST 的
--     `insert ... on conflict (id) do update`），而 PostgreSQL 在**冲突转更新**这条路上
--     **也要过 INSERT 策略的 `with check`**。真 Postgres 17 实测（PGlite）：
--     只满足 UPDATE 策略、INSERT 的 with check 不满足 → 整条 upsert 被拒
--     （`new row violates row-level security policy`）。
--     所以「谁能建」不能写得比「谁能改」更严，否则**改自己的东西会被顺带拦掉**。
--     16.3 里 classes 的 `owns_class()` 就是为这件事留的口子。
--
--  本段可重复执行（幂等）：策略一律 `drop policy if exists` + `create policy`。
-- ============================================================

-- -------- 16.1 这一段的策略矩阵（人话版，与 16.3 的 SQL 一一对应）--------
--
--   表 / 动作      | 谁能做
--   ---------------|--------------------------------------------------------------
--   classes  读    | 看得见这个班（§11 classes_visible，一字不改）
--            建    | 建档人是自己 + 有管理身份（super / admin / 年级主任 / 班主任）
--            改    | 管得着这个班（本年级 / 本班 / 校级）或**就是这个班的建档人**
--            删    | 同上（删班是级联删，跟"改"同一档）
--   students 读    | 看得见这个班（§11 students_visible）
--            增/改/删 | **管得着这个班**（任课老师不算 —— 用户口径：加删学生归管理身份）
--   assignments 读 | §13.4（自己建的 ∪ 看得见这个班且（全科视角 或 本科视角））
--            建    | 建档人是自己 + **在本班教这一科**（super / admin 兜底）
--            改    | **在本班教这一科**（批改、收缴、改日期都走这条）
--            删    | 自己建的 · 管得着这个班 · 在本班教这一科
--   calls    读    | 看得见这个班（§11 calls_visible）
--            写    | 管得着这个班 · 在本班任教（任一科）；**教室端不能发呼叫**
--   schedule 读    | 自己的排课表（teacher_id = 自己）· 班级课表（scope='class' 且班可见）
--            写    | 'mine' 行：建档人就是自己；'class' 行：**管得着这个班**（+ 教室端那条线）
--   classrooms 读  | 看得见这个班（§11 classrooms_visible）
--            写    | 建档人是自己 · 这个班看得见（教室端心跳走同一条）
--   ---------------|--------------------------------------------------------------
--   teachers / shared_files：**不在本矩阵里**，§7/§9 的"只能动自己那一行"原样保留
--     ⚠️ 例外一处：这两张表在 §17 各加了几条"教室端不算教师"的逐动作 restrictive
--        （2026-09-25 收紧裂缝 A：`teachers`；2026-09-27 收紧裂缝 C：`shared_files`）。
--        ⚠️ **两张表的原策略正文本身都没动**（`teachers_self` / `shared_files_own`
--        仍是 `for all`）—— 理由见 §17 开头与 §17.6：加 AND 不放宽任何权限，拆 OR 会漏动作。
--   teacher_roles / class_subjects / classroom_accounts / subjects / schools / grades：
--     只读（§10.4 / §12.1），写一律走服务端 `functions/api/*`（service_role），
--     数据库这一层**不 grant** insert/update/delete —— 免得同一个动作有两个入口
--   exams / exam_scores：第 15 段自己的判据（`can_edit_exam`），本段不碰

-- -------- 16.2 判据函数（策略里只调函数，别把 or 条件抄进策略）--------
--  与 §10.3 / §13.3 同一套手法：security definer + `set search_path = public`，
--  且**函数必须由表属主创建**（否则内层读取会再触发策略 → 无限递归）。
--  `_for(uid, …)` 变体一律 revoke：接受任意 uid 就等于"以任意人身份问权限"，
--  它只给属主在 SQL 编辑器里做核对用（见 16.6）。

-- 校级管理 = 最高管理员 + 教导处。
--  🔴 它与 `is_super_admin()` **不是同义词**：那个只有最高管理员。
--     本段里"两种身份一起"的场合（建班 / 加删学生 / 改成绩兜底）才用它；
--     需要区分的场合（将来交接超管）用 `is_super_admin()`。
--  🔴 不要在别处再抄一遍 `role in ('super','admin')`：口径一改就是两处不一致（I17）。
create or replace function public.is_school_admin_for(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from teacher_roles r
    where r.teacher_id = p_uid and r.role in ('super', 'admin')
  );
$$;

revoke all on function is_school_admin_for(uuid) from public, anon, authenticated;

create or replace function public.is_school_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select is_school_admin_for(auth.uid()) $$;

grant execute on function is_school_admin() to authenticated;

-- 我有没有这一档身份（只回答"我自己"）。给"新建"用 ——
--  新行还没有 id / grade_id，按"本年级 / 本班"收敛判不了（前端 classToRow 也不送 grade_id），
--  所以"建班"这一动只能判到"有没有这档身份"；建出来的空班之后能不能看/改，
--  仍然由 can_manage_class 管住。
create or replace function public.has_role_for(p_uid uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from teacher_roles r
    where r.teacher_id = p_uid and r.role = p_role
  );
$$;

revoke all on function has_role_for(uuid, text) from public, anon, authenticated;

create or replace function public.has_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select has_role_for(auth.uid(), p_role) $$;

grant execute on function has_role(text) to authenticated;

-- 管得着这个班：校级（super / admin）· 年级主任（本年级）· 班主任（本班）。
--  🔴 **故意不含任课老师** —— 任课老师看得见这个班（visible_class_ids 里有他），
--     但"加删学生 / 删别人的档案 / 改班级课表"不是他的事（用户 2026-09-27 口径）。
--     它 = `can_view_all_subjects_for` 去掉"教室端"那一支。
create or replace function public.can_manage_class_for(p_uid uuid, p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from teacher_roles r
             where r.teacher_id = p_uid and r.role in ('super', 'admin'))
    or exists (select 1 from teacher_roles r
                where r.teacher_id = p_uid and r.role = 'grade_head'
                  and r.scope_type = 'grade'
                  and r.scope_id = (select c.grade_id from classes c where c.id = p_class_id))
    or exists (select 1 from teacher_roles r
                where r.teacher_id = p_uid and r.role = 'head_teacher'
                  and r.scope_type = 'class' and r.scope_id = p_class_id);
$$;

revoke all on function can_manage_class_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.can_manage_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_manage_class_for(auth.uid(), p_class_id) $$;

grant execute on function can_manage_class(uuid) to authenticated;

-- 我在这班任教吗（**任一科**）—— 发呼叫、看设备状态用；不判科目。
create or replace function public.teaches_in_class_for(p_uid uuid, p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from class_subjects cs
    where cs.teacher_id = p_uid and cs.class_id = p_class_id
  );
$$;

revoke all on function teaches_in_class_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.teaches_in_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select teaches_in_class_for(auth.uid(), p_class_id) $$;

grant execute on function teaches_in_class(uuid) to authenticated;

-- 这个班是不是"我建的"（既有行，给 upsert 用：见 16.1 上面那段实测说明）。
--  它只回答"关于我自己的行"，不泄露别人的东西。
create or replace function public.owns_class_for(p_uid uuid, p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from classes c where c.id = p_class_id and c.teacher_id = p_uid
  );
$$;

revoke all on function owns_class_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.owns_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select owns_class_for(auth.uid(), p_class_id) $$;

grant execute on function owns_class(uuid) to authenticated;

-- 能不能改「这个班的这一科」的成绩/作业 —— 本段的核心判据。
--  口径 A（用户 2026-09-27 拍板）：**只有该班该科的任课老师**；
--  班主任 / 年级主任**只读** —— 所以这里**没有** grade_head / head_teacher 两支
--  （`多学科体系方案.md` §7 问题 4 问的就是这件事，答案就是 A）。
--  super / admin 保留为兜底（设计 §三 矩阵"上传/修改成绩 ✅" + 第 15 段 can_edit_exam 同口径）：
--  成绩录错了总得有人能改，而"必要时 super 兜底"是设计 §三 已经确认过的一句话。
--  ⚠️ 想让超管也不能改：把下面第一支（is_school_admin）删掉即可，别的都不用动。
create or replace function public.can_grade_subject_for(
  p_uid uuid,
  p_class_id uuid,
  p_subject_code text,
  p_subject text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    is_school_admin_for(p_uid)
    or teaches_subject_for(p_uid, p_class_id, p_subject_code, p_subject);
$$;

revoke all on function can_grade_subject_for(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.can_grade_subject(
  p_class_id uuid,
  p_subject_code text,
  p_subject text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_grade_subject_for(auth.uid(), p_class_id, p_subject_code, p_subject) $$;

grant execute on function can_grade_subject(uuid, text, text) to authenticated;

-- §10.3 那个 `can_grade(p_class_id, p_subject)`：**签名一个字没改**，只改函数体。
--  为什么必须改：老函数体里有 grade_head / head_teacher 两支 —— 那是设计稿 §五 的旧版本，
--  与已确认的"班主任 / 年级主任只读"矛盾。留着它，将来谁把它挂到策略上就是权限事故
--  （班主任能改全科成绩）。现在它转调 can_grade_subject（没有 code 就走显示名反查字典，
--  与 teaches_subject_for 的兼容期口径一致）。
create or replace function public.can_grade(p_class_id uuid, p_subject text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_grade_subject(p_class_id, null, p_subject) $$;

-- -------- 16.3 写策略矩阵（四个动作各自成条，好审计）--------
--  §11 §13 已经给了每个表的**读**策略（`*_visible`），这里只补 insert / update / delete。
--  ⚠️ 策略之间是 **OR**：一条 `for all` 就足以覆盖四个动作，
--     所以下面凡是补了逐动作策略的表，16.4 必须把对应的旧 `for all` 那条删掉 ——
--     不删的话"最宽的那条"说了算，收紧等于白做。

-- ---- 16.3.0 先补一件容易被忽略的事：旧策略也在给"读"----
--  🔴 `for all` 覆盖**四个**动作 —— 删掉 `classes_own` 这类旧策略时，
--     同时删掉的还有它那条 `using (teacher_id = auth.uid())` 的 **select** 分支。
--     只补写策略、不管读，就会出现"**建完就消失**"：
--     班主任新建的班 `grade_id` 是空的（前端 classToRow 不送这一列），
--     而 `visible_class_ids()` 判年级主任按 `grade_id`、判班主任按 `scope_id` ——
--     两样都对不上，新班立刻从列表里不见了，而且不报错。
--  §13.4 早就写过同一条纪律（"自己建的永远看得见"），只是当时只落在 assignments 上。
--  下面把这条纪律补齐到另外五张表，**保证"读"与删旧策略之前逐行相等**
--  （实测对照见 16.6 ① 与 `app/scripts/rls-checks.mjs` 的第十节「删旧策略前后对照」——
--    常驻回归，`npm run rls-checks`，8 个身份 × 11 张表逐行比对 A/B 两个库）。
--
--  班级：看得见（visible_class_ids）· **自己建的**（旧 classes_own 的 select 分支）
drop policy if exists classes_visible on classes;
create policy classes_visible on classes for select to authenticated
  using (id in (select visible_class_ids()) or teacher_id = auth.uid());

--  学生：所属班看得见 · **自己建的班**里的学生（旧 students_own 是按班级建档人判的）
drop policy if exists students_visible on students;
create policy students_visible on students for select to authenticated
  using (class_id in (select visible_class_ids()) or owns_class(class_id));

--  呼叫：本班看得见 · **自己发过的**（旧 calls_own 的 select 分支）
drop policy if exists calls_visible on calls;
create policy calls_visible on calls for select to authenticated
  using (class_id in (select visible_class_ids()) or teacher_id = auth.uid());

--  教室端设备行：本班的看得见 · **自己建的那一行**（旧 classrooms_own 的 select 分支）
--  ⚠️ 少了后半句，教师端给"自己录过的教室端"打的在线状态自己就看不见了。
drop policy if exists classrooms_visible on classrooms;
create policy classrooms_visible on classrooms for select to authenticated
  using (class_id in (select visible_class_ids()) or teacher_id = auth.uid());

--  `assignments_visible`（§13.4）**不用补** —— 它当年就是照这条纪律写的
--  （`teacher_id = auth.uid() or (看得见这个班 and (全科 或 本科))`）。
--  `schedule_own` 的 select 分支由下面 16.3 的 `schedule_mine_read` 接住。

-- ---- classes：建 / 改 / 删 ----
--  读：classes_visible（§11）。`classes_own` 是旧策略，16.4 删。
--
--  「建」为什么要 `owns_class(id)` 这一支：前端保存班级走 upsert，
--  而 upsert 在"冲突转更新"时**也要过 INSERT 的 with check**（见段首实测）。
--  没有这一支，建档人改名自己的班会被 INSERT 策略拦掉（UPDATE 策略本来是放行的）。
--  安全性由 UPDATE 策略把关：`owns_class(id)` 只对"我自己建的行"为真。
drop policy if exists classes_insert on classes;
create policy classes_insert on classes for insert to authenticated
  with check (
    teacher_id = auth.uid()
    and (
      is_school_admin()          -- 最高管理员 / 教导处
      or has_role('grade_head')  -- 年级主任（新班还没 grade_id，见 16.2 的说明）
      or has_role('head_teacher')-- 班主任
      or owns_class(id)          -- 既有行再存一次 = 更新，交给下面的 update 策略判
    )
  );

drop policy if exists classes_update on classes;
create policy classes_update on classes for update to authenticated
  using (can_manage_class(id) or owns_class(id))
  with check (can_manage_class(id) or owns_class(id));

drop policy if exists classes_delete on classes;
create policy classes_delete on classes for delete to authenticated
  using (can_manage_class(id) or owns_class(id));

-- ---- students：增 / 改 / 删（全是"管得着这个班"）----
--  读：students_visible（§11）。`students_own` 是旧策略（按班级建档人），16.4 删。
--  🔴 用户口径：加删学生 = super / admin / 年级主任 / 班主任；
--     **任课老师不算**（他看得见名单，但不动名单）。
drop policy if exists students_insert on students;
create policy students_insert on students for insert to authenticated
  with check (can_manage_class(class_id));

drop policy if exists students_update on students;
create policy students_update on students for update to authenticated
  using (can_manage_class(class_id))
  with check (can_manage_class(class_id));

drop policy if exists students_delete on students;
create policy students_delete on students for delete to authenticated
  using (can_manage_class(class_id));

-- ---- assignments：建 / 改(批改) / 删 ----
--  读：assignments_visible（§13.4 —— 那一条已经是"自己建的 ∪ 看得见且（全科 或 本科）"）。
--  `assignments_own` 是旧策略（for all, teacher_id = auth.uid()），16.4 删。
--
--  建：**自己建的**（建的人是当前登录者）+ **在本班教这一科**。
--      前端 `assignmentToRow` 恒把 teacher_id 写成当前老师，所以第一支永远成立；
--      真正起作用的是第二支 —— 用户口径："科任老师可以建自己任教班的"。
--  ⚠️ 于是班主任**建不了**别科的作业（即便他看得见那个班）：这是口径 A 的直接推论。
drop policy if exists assignments_insert on assignments;
create policy assignments_insert on assignments for insert to authenticated
  with check (
    teacher_id = auth.uid()
    and can_grade_subject(class_id, subject_code, subject)
  );

--  改：批改 / 收缴 / 临时保存 / 改日期都走这一条。
--      **班主任与年级主任改不了**（can_grade_subject 里没有他们）—— 用户明确要的"只读"。
--  ⚠️ `with check` 与 `using` 同款：否则能把行改成"另一个班 / 另一科"（自己管不着的地方）。
drop policy if exists assignments_update on assignments;
create policy assignments_update on assignments for update to authenticated
  using (can_grade_subject(class_id, subject_code, subject))
  with check (can_grade_subject(class_id, subject_code, subject));

--  删：自己建的 · 管得着这个班 · 在本班教这一科。
--      「自己建的」这一支是**故意留的**：任课关系被撤掉之后，
--      他建过的档案还得删得掉（否则那些档案谁也删不了），
--      与 §13.3 的"自己建的永远看得见"是同一条纪律。
drop policy if exists assignments_delete on assignments;
create policy assignments_delete on assignments for delete to authenticated
  using (
    teacher_id = auth.uid()
    or can_manage_class(class_id)
    or teaches_subject(class_id, subject_code, subject)
  );

-- ---- calls：写（发呼叫 / 再播一遍 / 标记状态）----
--  读：calls_visible（§11）。`calls_own` 是旧策略（for all, teacher_id = auth.uid()），16.4 删。
--  🔴 教室里那块屏**不在**能写的人里：学生碰得到那台机器，
--     "谁能发呼叫"只能是老师（设计 §五 红线）。教室端一边靠 calls_visible 读。
drop policy if exists calls_insert on calls;
create policy calls_insert on calls for insert to authenticated
  with check (
    teacher_id = auth.uid()
    and (can_manage_class(class_id) or teaches_in_class(class_id))
  );

drop policy if exists calls_update on calls;
create policy calls_update on calls for update to authenticated
  using (can_manage_class(class_id) or teaches_in_class(class_id))
  with check (can_manage_class(class_id) or teaches_in_class(class_id));

drop policy if exists calls_delete on calls;
create policy calls_delete on calls for delete to authenticated
  using (can_manage_class(class_id) or teaches_in_class(class_id));

-- ---- schedule_items：我自己的排课表 + 班级课表 ----
--  读：`schedule_class_visible`（§11，scope='class' 且班可见）**保留**；
--      这里补一条"我自己的排课表"。`schedule_own` 是旧策略，16.4 删。
--  写：'mine' 行 = 建档人就是自己（谁都能录自己的课表，这是个人数据）；
--      'class' 行 = **管得着这个班**（班级课表贴在教室里，是给全班看的）。
--  ⚠️ 教室端写班级课表走 §11.1 的 `schedule_classroom_write`（**保留，一条不许动**）：
--     它按 class_id 关联 classroom_accounts，少了它教室端粘贴课表会静默失败。
drop policy if exists schedule_mine_read on schedule_items;
create policy schedule_mine_read on schedule_items for select to authenticated
  using (teacher_id = auth.uid());

drop policy if exists schedule_mine_write on schedule_items;
create policy schedule_mine_write on schedule_items for all to authenticated
  using (
    teacher_id = auth.uid()
    and coalesce(scope, 'mine') <> 'class'
    -- 🔴 教室端账号**不是教师**，不许写"自己的排课表"（§17 裂缝 B）：
    --    它也是 auth.uid()，少了这一句它就能给自己名下塞 scope='mine' 的行 ——
    --    "教室端只有两处有限写"这句话在策略清单上就不成立了。
    and not is_classroom_account()
  )
  with check (
    teacher_id = auth.uid()
    and coalesce(scope, 'mine') <> 'class'
    and not is_classroom_account()
  );

drop policy if exists schedule_class_write on schedule_items;
create policy schedule_class_write on schedule_items for all to authenticated
  using (scope = 'class' and can_manage_class(class_id))
  with check (scope = 'class' and can_manage_class(class_id));

-- ---- classrooms：设备行（在线状态 / 心跳）----
--  读：classrooms_visible（§11）。`classrooms_own` 是旧策略，16.4 删。
--  ⚠️ `classrooms_heartbeat`（§11.1，教室端按 class_id 更新自己那一行）**保留**：
--     掉了教室大屏的在线状态就再也不更新（而且不报错）。
drop policy if exists classrooms_insert on classrooms;
create policy classrooms_insert on classrooms for insert to authenticated
  with check (teacher_id = auth.uid() and class_id in (select visible_class_ids()));

drop policy if exists classrooms_update on classrooms;
create policy classrooms_update on classrooms for update to authenticated
  using (teacher_id = auth.uid() or class_id in (select visible_class_ids()))
  with check (teacher_id = auth.uid() or class_id in (select visible_class_ids()));

drop policy if exists classrooms_delete on classrooms;
create policy classrooms_delete on classrooms for delete to authenticated
  using (teacher_id = auth.uid() or class_id in (select visible_class_ids()));

-- -------- 16.4 删旧策略（🔴 本仓库唯一不可逆的一步）--------
--  删的全是 §7 那批 `for all`：它们用 `teacher_id = auth.uid()` 覆盖了四个动作，
--  而新矩阵已经逐动作补全（16.3）。删掉之后：
--    · 读：完全由 §11 / §13.4 的 `*_visible` 负责（一条都没动）
--    · 写：完全由 16.3 的逐动作策略负责
--  **保留不动的旧策略**（刻意留下，别"顺手"删）：
--    shared_files_own（只动自己那一行，不在本矩阵里；它**正文没动**，
--    教室端那一条边界是 §17.6 加的三条 restrictive 表达的）
--    teachers_self（同上：正文没动，§17.1 用三条逐动作 restrictive 把教室端摘出去）
--    classes_visible / students_visible / assignments_visible / calls_visible /
--    schedule_class_visible / classrooms_visible（读，§11 §13）
--    classrooms_heartbeat / schedule_classroom_write（教室端的两处有限写，§11.1）
--    teachers_roles_read / class_subjects_read / classroom_accounts_read / subjects_read /
--    schools_read / grades_read（读，§10.4 §12.1）+ 第 15 段考试的两条
--
--  回退：见 16.7 —— 一行就能把最要紧的那条写回来。
drop policy if exists classes_own        on classes;
drop policy if exists students_own       on students;
drop policy if exists assignments_own    on assignments;
drop policy if exists calls_own          on calls;
drop policy if exists schedule_own       on schedule_items;
drop policy if exists classrooms_own     on classrooms;

-- -------- 16.5 这一段跑完之后，前端会怎样（"SQL 没跑也不崩"）--------
--  与 §12.4 / §13.6 / §15.6 同一套纪律：
--    · **没跑这一段**：旧策略还在，前端行为与改动前**完全一致**（本段只加函数/策略，
--      前端不依赖任何新对象 —— 没有新列、没有新表，所以不需要 `ensureXxx()` 探测）；
--    · **跑了这一段**：读的范围与跑之前逐人相等（§13.4 已经把读收窄过了，本段只动写），
--      写变严的地方按 16.1 的矩阵**应当**被拒；
--    · 被 RLS 拒的写入在前端表现为 `syncError`（乐观更新已经改了本地）——
--      所以上线这一段之前，请先跑 16.6 的核对 SQL。

-- -------- 16.6 核对：删旧策略前后，逐人逐动作（把下面整段粘进 SQL 编辑器）--------
--  ① 逐人可见量对照（**这是"删之前 / 删之后"要相等的那组数**）
--     🔴 怎么用：**跑本段之前先跑一次并记下来**，跑完再跑一次，两边逐行对比。
--     期望：**逐行相同** —— 本段只重写了读策略里"自己建的"那几支（16.3.0），
--     效果与旧 `for all` 策略的 select 分支**相等**；删旧策略不该让任何人少看见一行。
--     把 uuid 换成要核对的老师 id（`select id, name, subject from teachers;` 拿）。
with me as (select '00000000-0000-0000-0000-000000000000'::uuid as uid)
select
  (select count(*) from classes    where id       in (select visible_class_ids_for((select uid from me)))) as 看得见_班级,
  (select count(*) from students   where class_id in (select visible_class_ids_for((select uid from me)))) as 看得见_学生,
  (select count(*) from assignments where class_id in (select visible_class_ids_for((select uid from me)))) as 看得见_作业,
  (select count(*) from assignments where teacher_id = (select uid from me))                                 as 看得见_自己建的,
  (select count(*) from calls      where class_id in (select visible_class_ids_for((select uid from me)))) as 看得见_呼叫,
  (select count(*) from classrooms where class_id in (select visible_class_ids_for((select uid from me)))) as 看得见_教室端;

--  ② 逐人逐动作：把"谁能对这个班做什么"摆出来（用 _for 变体，不必登录）
--     期望：管理身份那几行 能管=true；任课老师 能管=false 但 能改这一科=true；
--           班主任 / 年级主任 能改这一科=**false**（用户口径："只读"）。
select
  t.name                                        as 老师,
  coalesce(t.primary_subject_code, t.subject)    as 主学科,
  c.name                                        as 班级,
  can_manage_class_for(t.id, c.id)              as 能管这个班,
  teaches_in_class_for(t.id, c.id)              as 在本班任教,
  (select string_agg(coalesce(cs.subject_code, cs.subject), '、')
     from class_subjects cs where cs.class_id = c.id and cs.teacher_id = t.id) as 任教科目,
  can_grade_subject_for(t.id, c.id, 'physics', '物理')  as 能改本班物理
from teachers t
cross join classes c
where can_manage_class_for(t.id, c.id) or teaches_in_class_for(t.id, c.id)
order by 4 desc, 1, 3;

--  ③ 矩阵审计：每张表**有哪些策略、各管哪个动作**（删完旧策略后照一眼）
--     期望：classes / students / assignments / calls / schedule_items / classrooms
--           每一行都能在 16.1 的表里找到出处；**教室里那块屏不出现在任何写策略里**。
-- select tablename, policyname, cmd, roles
--   from pg_policies where schemaname = 'public' order by tablename, cmd, policyname;

--  ④ 🔴 教室端的安全边界：它**不该有**任何一张业务表的写权限。
--     把教室端账号的 uuid 填进去，下面每一条都应该是 0 行 / 抛"策略拒绝"。
--     最省事的做法是照 16.6 ③ 的清单人工看一眼，或者跑 `npm run rls-checks`
--     （`app/scripts/rls-checks.mjs` 第七节：给教室端逐个动作打 11 条写操作，全拒才算过；
--       顺带用 `pg_policies` 静态审一遍「assignments 上没有任何一条策略提到 classroom_accounts」）。
-- with room as (select '77777777-7777-7777-7777-777777777777'::uuid as uid)
-- select
--   (select count(*) from classroom_accounts where id = (select uid from room)) as 教室端账号行数,
--   (select count(*) from class_subjects where teacher_id = (select uid from room)) as 任课关系行数,
--   (select count(*) from teacher_roles  where teacher_id = (select uid from room)) as 身份行数;
--   —— 两个 0 意味着他在 can_manage_class / can_grade_subject / teaches_in_class
--      三个判据上**永远为假** → 16.3 的写策略一条都匹配不上 → 只读。

-- -------- 16.7 回退 SQL（删旧策略是本仓库唯一不可逆的动作，这里必须给出退路）--------
--  ① 只退最要紧的一条（**一行**）：把"谁建的谁能改"写回来。
--     它恢复的是作业那套旧写判据 —— 出问题（老师改不了自己的档案）时先跑这一行。
--  create policy assignments_own on assignments for all to authenticated
--    using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
--
--  ② 完整回退：把 §7 那六条原样重建（内容与 §7 一字不差，只是把 `create` 换成幂等写法）
--  drop policy if exists classes_own on classes;
--  create policy classes_own on classes for all to authenticated
--    using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
--  drop policy if exists students_own on students;
--  create policy students_own on students for all to authenticated
--    using (exists (select 1 from classes c where c.id = students.class_id and c.teacher_id = auth.uid()))
--    with check (exists (select 1 from classes c where c.id = students.class_id and c.teacher_id = auth.uid()));
--  drop policy if exists assignments_own on assignments;
--  create policy assignments_own on assignments for all to authenticated
--    using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
--  drop policy if exists calls_own on calls;
--  create policy calls_own on calls for all to authenticated
--    using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
--  drop policy if exists schedule_own on schedule_items;
--  create policy schedule_own on schedule_items for all to authenticated
--    using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
--  drop policy if exists classrooms_own on classrooms;
--  create policy classrooms_own on classrooms for all to authenticated
--    using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
--  —— 回退**只会放宽**（并集变大），不会让谁看不见东西；
--     而 16.3 的新策略**不用删**：新旧并存时"能做的"是并集，正好等于改动前。
--     要回到严格收口，把上面这些 drop + create 再删一次即可（本段幂等）。

-- -------- 16.8 这一段**不做**什么（免得后来的人以为漏了）--------
--  · 走班教学班（`teaching_groups` / `stream_key`）→ 阶段 4，用户明确"教学班是固定的，
--    只在生物/地理/政治三科存在，具体班型待确认"，本轮**一个字都不动**。
--    ⚠️ 将来做走班时，本段这两处要一起改，否则会挡住它：
--      ① `can_manage_class(c.id)` 的年级主任一支按 `classes.grade_id` 判；
--         走班作业若挂教学班而不是行政班，需要新的判据（教学班的老师）；
--      ② `assignments_insert/update` 只认 `class_id + subject`。
--         走班作业的"一份档案属于多个班"要另加判据（见 `多学科体系方案.md` §3.4.3）。
--  · `class_subjects` 的 unique 换列（(class_id, subject, teacher_id) → 加 subject_code）
--    → 阶段 3 的遗留项，本次不碰（换 unique 是破坏性迁移，与"收口"分开做）
--  · `teacher_roles` / `class_subjects` / `classroom_accounts` 的**客户端写策略**
--    → 指派身份 / 任课关系只走服务端（`/api/teacher-account`），
--      数据库层刻意不 grant（§13.7 已经写过理由：同一个动作不要两个入口）
--  · 教室端账号创建权限里 `admin` 的定位（`functions/api/classroom-account.ts` 的 mayManage）
--    → 教室端那条线，本轮刻意不动（§13.1 的留档仍然有效）
--  · 删 `assignments.subject` / `teachers.subject` / `class_subjects.subject` 旧列
--    → 要等体检连续为 0，而且前端还在按显示名反查字典（§12.4）

-- ============================================================
--  17. 收口 · 教室端的**三条**裂缝（2026-09-25 拍板「收紧」A/B；2026-09-27 收紧 C）
--
--  背景：`app/scripts/rls-checks.mjs`（PGlite 跑真 Postgres + 真策略）实测出这些裂缝，
--  当时**只记在报告里、没有判失败**。用户 2026-09-25 拍板「收紧」（A / B），
--  2026-09-27 又拍板收掉最后一条 C。它们是：
--
--   裂缝 A：教室端能改 `teachers` 里**自己那一行**。
--     根因是两件事叠在一起：① `teachers_self`（§7）是 `for all`，条件是 `id = auth.uid()`；
--     ② `handle_new_user` 触发器**给每个 auth 用户都建了一行 teachers** ——
--     教室端账号也有（`classroom_accounts.id` 指向 auth.users 的同一个 uuid）。
--     于是它能改自己那行的 name / subject。那块屏是挂在教室里给学生看的，
--     **不该有任何写权限**（设计 §五 红线）。
--
--   裂缝 B：教室端在策略上能写自己名下 `scope='mine'` 的排课表行。
--     `schedule_mine_write` 只要求 `teacher_id = auth.uid()`，而教室端账号也是 auth.uid()。
--     前端走不到这条路（`Classroom.tsx` 的粘贴课表恒写 `scope:'class'`），
--     所以影响面≈0 —— 但"教室端只有两处有限写"这句话在策略清单上不成立，
--     而策略清单是这个项目的安全边界说明书，**它不能是错的**。
--     已在 §16.3 的 `schedule_mine_write` 里补上 `and not is_classroom_account()`。
--
--   裂缝 C（2026-09-27 收紧）：教室端能往 `shared_files` 插 / 改 / 删自己名下的行。
--     `shared_files_own`（§9）是 `for all ... using (teacher_id = auth.uid())`，
--     上传时 `teacher_id` 就是当前登录者 —— 所以教室里那个账号也能"上传"。
--     与 A / B **同一个根**（触发器给了每个 auth 用户一行 teachers + 策略只认 auth.uid()）。
--     收紧写法见 **§17.6**（同一个理由：加 AND，不拆 OR）。
--
--  为什么这一节的主语是"加"而不是"改 §7 的 teachers_self"：
--    · `teachers_self` 原来是一条 `for all`。`teachers` 是**外键的根**
--      （classes / assignments / schedule_items / classrooms / calls 全都 references 它），
--      而前端每一次"我的资料"保存走的都是 **upsert**（`saveTeacher` → `on conflict (id) do update`），
--      在 PostgreSQL 里那条路**同时要过 INSERT 的 with check**（§16.3 发现二，真 PG 实测过）。
--    · 所以"教室端不许写"这一条**只用逐动作 restrictive 策略**表达
--      （`for insert` / `for update` / `for delete` + `not is_classroom_account()`）：
--      策略之间 permissive 是 OR、最后再与所有 restrictive **AND**，
--      所以它**不会放宽任何权限**，只是把那一个身份从写动作里摘出去。
--      §7 的 `teachers_self` 一个字不用动，回退也只是删掉那几条。
--      **收紧动作里，"加一条 AND" 比"拆一条 OR"稳得多** —— 拆 `for all` 时漏掉任何一个动作，
--      症状都是教师"保存失败 = 刷新即丢"，而且**不报错**（§16.3 发现一）。
--
--  判据：`is_classroom_account()`，定义在 **§10.5**（必须在建策略之前存在，
--    否则 `create policy` 这一步就报 `function … does not exist` —— 真 PG 17 实测）。
-- ============================================================

-- -------- 17.1 裂缝 A：teachers 的写权限里**摘掉教室端** --------
--  `for all` = 覆盖 select / insert / update / delete 四个动作，正好把"改自己那一行"
--  （§7 的 `teachers_self` 给的那条路）整个堵掉；读不受影响（restrictive 只作用于
--  策略的 `using` 判定，而它这里为真时对读毫无影响 —— 教师的 `teachers_self` 照旧放行）。
drop policy if exists teachers_not_classroom on teachers;
create policy teachers_not_classroom on teachers
  as restrictive for all to authenticated
  using (not is_classroom_account())
  with check (not is_classroom_account());

-- -------- 17.1 裂缝 A：teachers 的写权限里**摘掉教室端** --------
--  🔴 **必须是三条逐动作策略，不能写成一条 `for all`** —— 这是本轮实测踩到的坑：
--     restrictive 的 `using` 对 **SELECT 也生效**，写成 `for all` 会把教室端**读自己那一行**
--     一起挡掉（`rls-checks` 第三节「逐人可见量」当场就红了：teachers 1 → 0），
--     而"读"这一半本轮一个字都不该动。DML 才需要 `with check`，`for delete` 只有 `using`。
--
--  ⚠️ `handle_new_user` 触发器不受这里影响：它是 `security definer`，
--     插入以**函数属主**（表属主默认绕过 RLS）身份执行 —— 下面三条拦不到它。
--     （"加了守卫之后建号还建不建得出来"是这一段最要紧的副作用，实测见 rls-checks 第二/七节。）
--
--  ⚠️ 教师那一侧**一个字都没动**：`teachers_self`（§7 的 `for all`）仍然原样躺在那里，
--     老师改自己那一行照旧走它；三条 restrictive 对老师恒真（`is_classroom_account()` = false）。
--     这正是"别把真正的教师一起挡了"的实现方式：判据是**身份**（classroom_accounts 里有没有自己），
--     不是"像不像老师"。
--  ⚠️ 第一条 `drop` 是**清理用**的：本段最早写成一条 `for all` 的 `teachers_not_classroom`，
--     实测发现 restrictive 的 `using` 对 SELECT 也生效（教室端会读不到自己那行）→ 改成下面三条。
--     留着这一行，任何跑过中途版本的库重跑本段都会被清干净（幂等）。
drop policy if exists teachers_not_classroom on teachers;

drop policy if exists teachers_not_classroom_insert on teachers;
create policy teachers_not_classroom_insert on teachers
  as restrictive for insert to authenticated
  with check (not is_classroom_account());

drop policy if exists teachers_not_classroom_update on teachers;
create policy teachers_not_classroom_update on teachers
  as restrictive for update to authenticated
  using (not is_classroom_account())
  with check (not is_classroom_account());

drop policy if exists teachers_not_classroom_delete on teachers;
create policy teachers_not_classroom_delete on teachers
  as restrictive for delete to authenticated
  using (not is_classroom_account());

-- -------- 17.2 裂缝 B：教室端在 schedule_items 上只留 scope='class' 那一支 --------
--  §16.3 已经把 `not is_classroom_account()` 写进 `schedule_mine_write`（策略正文那处管
--  "能不能写"）；这里再用一条 restrictive 策略把边界**声明**出来（AND，不放宽任何东西）：
--  教室端能写的只能是 `scope='class'` 的行（= §11.1 的 `schedule_classroom_write`
--  与 `classrooms_heartbeat` 那两处有限写），`scope='mine'` 一律拒。
--
--  为什么两处都写：只有策略正文那处时，`pg_policies` 里 `schedule_mine_write` 的条件
--  长得像"谁都能写自己的排课表"，下一个读策略清单的人会把裂缝 B 再犯一遍 ——
--  而策略清单是这个项目的安全边界说明书。
drop policy if exists schedule_classroom_scope_only on schedule_items;
create policy schedule_classroom_scope_only on schedule_items
  as restrictive for all to authenticated
  using (not is_classroom_account() or scope = 'class')
  with check (not is_classroom_account() or scope = 'class');

-- -------- 17.3 这一段跑完之后，前端会怎样（"SQL 没跑也不崩"）--------
--  · **没跑这一段**：教室端那三条裂缝还在（与改动前完全一致），教师端行为一个字不变；
--  · **跑了这一段**：教师端与教室端的**读**完全不变（`teachers_self` / `shared_files_own`
--    一条没删、一条没改，restrictive 对教师恒真），教室端的两条合法写
--    （心跳 / 粘贴本班班级课表）照旧通过 —— 实测见 rls-checks 第七节；
--  · 一处**故意不要**的东西（免得后来的人"顺手补上"）：
--    没有 `teachers` 的 DELETE 策略 → 客户端删不掉 teachers 行。
--    全仓没有任何前端路径会删它（账号由 `functions/api/*` 用 service_role 管，
--    绕过 RLS），而 §16.1 矩阵里 `teacher_roles` / `class_subjects` / `classroom_accounts`
--    同样是"数据库层不给客户端写"。这与"教室端不该有写权限"是同一条纪律。
--  · 被拒的写入在前端表现为 `syncError`（乐观更新已经改了本地），
--    所以上线这一段之前，先跑 `npm run rls-checks`（它会逐条打这三条裂缝）。
--
-- -------- 17.4 回退（七个 drop + 一处正文，幂等）--------
--    drop policy if exists teachers_not_classroom_insert on teachers;
--    drop policy if exists teachers_not_classroom_update on teachers;
--    drop policy if exists teachers_not_classroom_delete on teachers;
--    drop policy if exists schedule_classroom_scope_only on schedule_items;
--    drop policy if exists shared_files_not_classroom_insert on shared_files;
--    drop policy if exists shared_files_not_classroom_update on shared_files;
--    drop policy if exists shared_files_not_classroom_delete on shared_files;
--    -- `schedule_mine_write` 的正文也要把 `and not is_classroom_account()` 去掉（§16.3）
--  —— 回退**只会放宽**（AND 的那一半没了），不会让谁看不见东西，也不用重建任何旧策略。
--     ⚠️ `shared_files_own` 的正文**本来就没动过**，所以裂缝 C 的回退就是删那三条。
--
-- -------- 17.5 自检（跑完这一段之后照一眼）--------
--  ① 策略清单：teachers 上多三条 `teachers_not_classroom_*`、`shared_files` 上多三条
--     `shared_files_not_classroom_*`（permissive = RESTRICTIVE）；
--     schedule_items 上多一条 `schedule_classroom_scope_only`（同）。
--     ```sql
--     select tablename, policyname, cmd, permissive
--       from pg_policies where schemaname = 'public'
--        and tablename in ('teachers', 'schedule_items', 'shared_files') order by tablename, cmd, policyname;
--     ```
--  ② 判据函数：把教室端账号的 uuid 填进去，应当为 true；换成一位真老师应当为 false。
--     ```sql
--     -- select public.is_classroom_account();  -- 以登录者身份跑
--     ```
--  ③ 常驻回归：`cd app && npm run rls-checks` —— 第七节逐条打这三条裂缝，
--     并且静态钉住"teachers / schedule_items / shared_files 上的写策略里都提到教室端"、
--     "三条裂缝的 restrictive 里都没有 SELECT"（读那一半不许被误伤）。
--     反向对照：真老师改自己那行 teachers / 写自己名下 `scope='mine'` 的排课表 /
--     往 `shared_files` 上传，**都必须照旧通过**。
--
-- -------- 17.6 裂缝 C：`shared_files` 的写权限里**摘掉教室端**（2026-09-27 收紧）--------
--  这一节从"已知未收紧项"变成"已收紧"。原来的记录（留档，说明它为什么拖了一轮）：
--    PGlite 逐人逐动作跑出来发现，教室端账号在策略上**也**能往 `shared_files` 插一行
--    （§9 的策略是 `for all ... using (teacher_id = auth.uid())`，而 `Files.tsx` 上传时
--    `teacher_id` 就是当前登录者）。它与裂缝 A / B 是**同一个根**。
--    上一轮没收的理由是"它不在 §16.1 的矩阵里 + 教室端页面没有上传入口"，用户 2026-09-27 拍板：收。
--
--  🔴 **为什么这里是"加三条逐动作 restrictive"，而不是"改 `shared_files_own` 的正文"**：
--    `shared_files_own` 是**一条 `for all`**（`shared_files` 上只有这一条策略），
--    它的 `using` **同时**在给 SELECT —— 而教室那块屏**要读**这个表
--    （`Classroom.tsx` → `listFiles()`，教师端传过去的题图/答案就靠它拉下来）。
--    所以：
--      · 改正文（`using (teacher_id = auth.uid() and not is_classroom_account())`）
--        = 连**读**一起改掉。这正是裂缝 A 当初踩过的坑（restrictive / using 对 SELECT 也生效，
--        `rls-checks` 第三节"逐人可见量"当场红：teachers 1 → 0）。
--      · 拆 `for all` 成四条 = 漏一个动作就是"老师传完文件、刷新即丢且不报错"（§16.3 发现一）。
--    所以：**原策略一个字不动**，只加三条逐动作的 AND（不含 SELECT）。
--    代价是"这条 `for all` 的条件看着像谁都能写自己那一行"—— 由 §17.5 的策略清单自检
--    与 `rls-checks` 第七节的静态审计兜住（名字里带 `not_classroom`，清单上看得见）。
--
--  ⚠️ 读的那一半**必须原样保留**（`rls-checks` 有一条反向断言专门钉它：
--     教室端照旧读得到自己名下那一行）。真老师那边一个字都不受影响：
--     老师不在 `classroom_accounts` 里 → `is_classroom_account()` 恒 false → restrictive 恒真。
drop policy if exists shared_files_not_classroom_insert on shared_files;
create policy shared_files_not_classroom_insert on shared_files
  as restrictive for insert to authenticated
  with check (not is_classroom_account());

drop policy if exists shared_files_not_classroom_update on shared_files;
create policy shared_files_not_classroom_update on shared_files
  as restrictive for update to authenticated
  using (not is_classroom_account())
  with check (not is_classroom_account());

drop policy if exists shared_files_not_classroom_delete on shared_files;
create policy shared_files_not_classroom_delete on shared_files
  as restrictive for delete to authenticated
  using (not is_classroom_account());

--  ⚠️ **收紧之后仍然存在的一件事（不是本轮引入的，别当成回归）**：
--     `shared_files_own` 只给"自己传的那一行"，所以云端模式下
--     **教室端读不到老师上传的行**（教师 A 也读不到教师 B 的行）——
--     "教师端 → 教室端的文件互传"这条路在**读**这一侧本来就不成立（§9 的老形状）。
--     本轮按用户口径只收紧"写"，**没有动读**（动读要另拍板、且要连着客户端一起改）。
--     发现与影响写在 `功能设计与不变量.md` §十七·补 的补.4。

-- ============================================================
--  18. 判据函数的 `_for` 变体（2026-09-27 补）：为什么每个判据都要两件套
--      本节登记的：**`can_edit_exam_for`**（考试档案的写判据）
-- ============================================================
--
--  本节**一行可执行的 SQL 都没有**（除了注释里的核对查询）—— 与 §12.5 / §15.4 / §16.6 同类：
--  自检段不建对象。它是"登记表 + 一条纪律 + 一段核对 SQL"。
--
--  为什么专门写一节：`can_edit_exam_for` 这个变体此前**故意没有建**
--  （§15.4 的旧注释说"它不需要在编辑器里被指定人核对"），代价是两条：
--    ① 在 Supabase SQL 编辑器里**验不了考试那条写判据** —— 编辑器里 `auth.uid()` 是 NULL，
--       `can_edit_exam(...)` 对**任何人**都返回 false（用户实测：示例教师 / demo-teacher / 所有班全 false）。
--       于是"示例教师能不能建高二(1)班的物理考试"这个最基本的问题，当时**没有答案**；
--    ② `app/scripts/rls-checks.mjs` 里对考试写判据**一条断言都没有**（没法以指定身份调用）——
--       而那条判据守着的正是"谁能建 / 改考试档案"。
--
-- -------- 18.1 纪律：判据一律**两件套**（裸版 + `_for` 版）--------
--  · `xxx_for(p_uid, …)`：**函数体在这里**，显式传人 —— 编辑器核对 / 回归脚本用；
--    **一律 revoke**（接受任意 uid 就等于"以任意人身份问权限"，见 §16.2 开头那段）；
--  · `xxx(…)`：读 `auth.uid()` 的**薄包装**，正文只有一行 `select xxx_for(auth.uid(), …)`——
--    策略只准引用它（签名稳定，以后换判据不用动策略）。
--  🔴 **为什么必须有 `_for` 版（这一条值得当约定记下来：不是"顺手补一个"，是"不补就没法验证"）**：
--    编辑器里没有登录态（`auth.uid()` = NULL），回归脚本里也没法"以某人的身份问一句"——
--    裸版在编辑器里只会恒 false（或恒 NULL），看起来像"权限收得很紧"，
--    实际是**假通过 / 假失败**：判据对不对，一个字都没验。
--    §12.5 / §13.5 / §16.6 的核对 SQL 全都靠 `_for` 变体，理由同此。
--  ⚠️ 顺序：`_for` 必须建在**薄包装之前**，两者都必须建在**引用它们的策略之前**——
--    PostgreSQL 在 `create function` / `create policy` 那一刻就解析名字（§18.4 有实测）。
--
-- -------- 18.2 `can_edit_exam_for` 登记（2026-09-27 新增）--------
--  签名：`public.can_edit_exam_for(p_uid uuid, p_class_ids uuid[], p_subject_code text, p_subject text)`
--    ⚠️ 第一个业务参数是**数组**（一次考试可以多班），别的判据是标量 `p_class_id` —— 别抄错。
--  位置：**§15.2**（紧跟薄包装 `can_edit_exam` 之前）—— **不在本节**，理由见 18.4。
--  用途：① SQL 编辑器里核对"谁能建 / 改哪一份考试档案"；② `rls-checks` 第十三节逐身份断言。
--  语义（**钉死，改它之前先读这里；回归也钉着它**）：
--    · 答的是"`p_uid` 能不能建 / 改 `p_class_ids` 这一份考试档案"；
--    · 多班数组是 **any**：`class_ids = [我教的班, 我不教的班]` → **true**
--      （只要**有一个**班我教这一科；**不是**"每个班都要我教"）。
--      为什么：班级考试只有一个班；年级考试是多人协作 —— 别的班的分数由那个班的任课老师自己录
--      （§15.2 的"为什么'任一班'就够"）。所以这个数组的语义是"**这份档案涉及哪些班**"，
--      不是"要求我教全部这些班"。
--    · 空数组 / NULL → 对任课老师 **false**；对 super / admin 仍然 true（兜底那一支不看班）。
--    · 学科：先看 `subject_code`，认不出再按 `subject` 显示名去 `subjects` 反查；
--      **认不出来 = 不匹配**（不猜，与 §13.3 同口径）。
--    · super / admin 兜底**保留**（用户 2026-09-27 拍板；与 §16.2 的 `can_grade_subject_for` 同口径）；
--      想让超管也不能改：删掉函数体第一支即可，别的不用动。
--    · **班主任 / 年级主任不在判据里**：他们读得宽（§15.3 的读策略）、**写不了别人的班**（I27 同族）。
--    · **教室端 false**：那块屏在 `exams` / `exam_scores` 上**一条写策略都没有**（§15.3 末）。
--      ⚠️ 它与"读"是两件事：§15.3 的读策略用的是 `visible_class_ids()`，教室端**读得到**本班考试
--      （为将来的"逐题正确率"留的）—— 设计文档 §14.7 里"连 select 都拿不到"那句话与实码不一致，
--      实测见 rls-checks 第十三节；要改的是文档或那条读策略，**不是**这里的写判据。
--
-- -------- 18.3 编辑器核对（把下面整段粘进 SQL 编辑器）--------
--  ① 判**每一行自己的老师**能不能改这一行（推荐问法：不会把"行主"和"核对对象"看串，
--     见 §15.4 ② 的那条告警）：
-- select t.name as 老师, c.name as 班级, coalesce(cs.subject_code, cs.subject) as 学科,
--        can_edit_exam_for(t.id, array[c.id], cs.subject_code, cs.subject) as 他能改这一行
--   from class_subjects cs
--   join classes c on c.id = cs.class_id
--   join teachers t on t.id = cs.teacher_id
--  order by 1, 2;
--  期望：**每一行都是 true** —— 任课关系在，这一科就跑得动判据；
--        调成别人的 id（第一参数）看它会变成 false，那才是"写不了别人的班"。
--  ② 问一个具体的人 + 试多班数组的语义（把 uuid 换成真的）：
-- select can_edit_exam_for('<老师的 uuid>', array['<班1>'::uuid, '<班2>'::uuid], 'physics', '物理');
--  ③ `_for` 变体**必须都 revoke**（这条期望 **0 行**；机器版在 rls-checks 第十三节）：
-- select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname like '%\_for'
--    and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
--      or has_function_privilege('anon', p.oid, 'EXECUTE'));
--  ④ 顺便看见"裸版在编辑器里为什么恒 false"（**不是权限收紧了**，是 auth.uid() = NULL）：
-- select can_edit_exam(array[(select id from classes order by created_at limit 1)], 'physics', '物理');
--
-- -------- 18.4 为什么定义落在 §15.2，而不是像别的节那样落在文件末尾 --------
--  实测（PGlite = WebAssembly 版**真 PostgreSQL 17**，一次性探针）：
--    · `create function … language sql as $$ select 还不存在的函数() $$` → **当场报错**
--      `function … does not exist`（同理：引用还不存在的表 → `relation … does not exist`）；
--    · `create policy … using (还不存在的函数())` → **当场报错**（§17 那段注释里的同一条坑）。
--  所以"函数体搬到本节、§15.2 只留薄包装"这条路**走不通**：schema.sql 会在 §15.2 就断掉。
--  推论（**改判据时记住**）：
--    · 本条判据的 super/admin 那一支只能**就地**写 `role in ('super','admin')`，
--      **不能**改调 §16.2 的 `is_school_admin_for()`（它比 §15 晚）—— 那是 I17 的**已知重复处**：
--      口径与 §16.2 逐字相同，改动时两处一起改（rls-checks 第十三节钉着两者一致）；
--    · 将来新增判据，位置要放在**第一个调用方之前**，别只看节号。
--
-- -------- 18.5 现在有哪些 `_for` 变体（照这张表点，别漏 revoke）--------
--  §10.3 `visible_class_ids_for(uuid)`
--  §13.2 `is_super_admin_for(uuid)` · `can_manage_teachers_for(uuid)`
--  §13.3 `can_view_all_subjects_for(uuid, uuid)` · `teaches_subject_for(uuid, uuid, text, text)`
--  §15.2 **`can_edit_exam_for(uuid, uuid[], text, text)`** ← 本节登记的这一个（2026-09-27 补）
--  §16.2 `is_school_admin_for(uuid)` · `has_role_for(uuid, text)` · `can_manage_class_for(uuid, uuid)`
--        · `teaches_in_class_for(uuid, uuid)` · `owns_class_for(uuid, uuid)`
--        · `can_grade_subject_for(uuid, uuid, text, text)`
--  合计 **12 个**，**每一个后面都紧跟一句 `revoke all on function … from public, anon, authenticated`**。
--  新增判据时四样一起加：`_for` + 裸版 + revoke + rls-checks 里至少一条断言（否则就是"加了没人钉"）。
--
-- -------- 18.6 这一段跑完之后，前端会怎样（"SQL 没跑也不崩"）--------
--  · **没跑这一段**：前端行为一个字不变（本节不建对象）；
--  · **跑了这一段**：策略 / 前端 / 教室端全部与改动前逐字相同（`can_edit_exam` 的签名与语义都没变，
--    只是函数体改成转调 `can_edit_exam_for`）—— 多出来的只是"考试写判据第一次可以被验证"。
--  · 回退（幂等，两行）：把 §15.2 的薄包装正文换回原来的 `with me as (select auth.uid() as uid) …`，
--    再 `drop function if exists can_edit_exam_for(uuid, uuid[], text, text);`。

