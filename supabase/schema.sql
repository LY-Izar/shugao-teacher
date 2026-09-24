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
--  13. 自检：确认每张表都开了 RLS
--     跑完应返回 0 行；返回任何一行都说明有表漏开
-- ============================================================
-- select tablename from pg_tables
--  where schemaname = 'public' and rowsecurity = false;
