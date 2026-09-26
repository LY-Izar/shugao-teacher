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

-- 🆕 2026-09-28：未读通知的**唯一**依据（`功能设计与不变量.md` I49 / 通知方案 §九.6）。
--  · 语义 = 「我上次把通知列表看到哪儿了」，**一行一个老师、一行一个时间戳**。
--  · 🔴 它**不是**"谁读过哪一条"：没有 `notice_reads` 表，也不会有。
--    未读数 = 有 `created_at > notice_seen_at` 的、我看得到的、未撤下未过期的通知的条数。
--  · 为空 = 从没打开过通知页 → 全部算未读（**不是**"全部已读"）。
--  · ⚠️ 一个字段只能有一种语义：它只用于通知，不许拿它做"最后活跃时间"之类的第二用途。
alter table teachers add column if not exists notice_seen_at timestamptz;

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
  -- ⚠️ **老列，历史遗留**：旧界面是"给哪个班看（不选 = 所有班）"这个下拉框，所以
  --    这一列为空曾经表示"所有班级可见"。**从 §19（2026-09-28）起这句话作废**：
  --    班级归属改用 `class_ids uuid[]`（空数组 = 无归属 = 教室端看不到），
  --    这一列**没有任何策略、也没有任何前端代码读它**，只剩两个作用：
  --      ① §19.2 的搬迁来源（老师当时明确选过的那个班）；② "线上库还没跑 §19"时前端的兼容写入列。
  --    别照下面这句老注释去理解现在的行为。
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

-- 存储策略：读写**自己目录**下的文件。
-- ⚠️ `classroom_files_read` 从 **§19.4.3（2026-09-28）** 起被**放宽了一次**（多一支
--    "这一份文件我读得到那一行，就读得到这个对象"）—— 否则教室端读得到 `shared_files` 的行、
--    却拿不到文件直链（"行读通了、字节读不通"）。**写（insert / delete）两条一个字没动。**
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
--
--  🆕 2026-09-28「管理架构与角色权限」这一轮把 `role` 从 5 个值扩到 **12 个值**
--     （`管理架构与角色权限方案.md` §六.2）。四条不能破的纪律：
--     ① **`admin` 这个代号保留、一个字节都不改** —— 它现在显示成「教务处」
--        （用户查过库里 `admin` 有 0 行 → 纯文案、零数据迁移）。改代号是破坏性迁移。
--     ② **`teacher` 这个历史值留着**（任课教师不写这张表，写 `class_subjects`）——
--        它躺在 check 里不影响任何东西，删它反而是破坏性迁移。
--     ③ **新代号不进任何判据函数**（除本段 §10.3 / §13 明确点名的那几处）——
--        "拿了这个身份什么都多看不到"与"没有这一档"等价，是**显式不加**，不是忘了加。
--     ④ 三档校级（principal / vice_principal / principal_assistant）**在数据库里逐格相同**
--        （方案 §三.2）：三个显示名、一条判据。要分开就得先有"分管范围"这个字段。
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

-- -------- 10.1.1 🆕 14 档身份（2026-09-28）--------
--  这一段**只加值、只加列、只换索引**，一个旧值都不删 —— 跑完之后行为一个字节不变
--  （库里没有任何一行用新代号）。回退 SQL 见本段末尾。
--
--  ⚠️ 顺序纪律（照 §16.3 那条"先补新的、再删旧的"）：约束与索引一律
--     **先建新的、后删旧的** —— 顺序反了就会有"两边都不在"的窗口。
--     `create policy` 会当场解析函数名，约束/索引同理：先建后删。

-- ① role 扩到 12 个值。
--    ⚠️ 这里**不用** `drop constraint if exists` 那套（那会留下一个窗口）：
--       先 add 一个新的约束（名字带 _v2），再 drop 旧的 —— 两者短暂并存，任何一刻都有约束在。
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'teacher_roles'::regclass and conname = 'teacher_roles_role_check_v2'
  ) then
    alter table teacher_roles add constraint teacher_roles_role_check_v2
      check (role in (
        'super',                                             -- 最高管理员（平台角色，不是学校岗位）
        'admin',                                             -- 教务处（**代号保留、显示名改**）
        'principal', 'vice_principal', 'principal_assistant', -- 校长 / 副校长 / 校长助理（逐格相同）
        'office_head', 'moral_edu_head',                      -- 办公室主任 / 德育处主任
        'grade_head', 'head_teacher',                         -- 年级主任 / 班主任
        'subject_lead', 'lesson_prep_lead',                   -- 教研组长 / 备课组长
        'teacher'                                             -- 任课教师（历史值，留着）
      ));
  end if;
  if exists (
    select 1 from pg_constraint
     where conrelid = 'teacher_roles'::regclass and conname = 'teacher_roles_role_check'
  ) then
    alter table teacher_roles drop constraint teacher_roles_role_check;
  end if;
end $$;

-- ② scope_type 扩 2 个值：'subject'（本校一科，跨年级）· 'grade_subject'（一个年级的一科）。
--    🔴 `'department'` **刻意不加** —— 平台里没有一条数据是按部门分的，
--       建部门表 = 多一个真相来源（方案 §5.4 第 3 层）。
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'teacher_roles'::regclass and conname = 'teacher_roles_scope_type_check_v2'
  ) then
    alter table teacher_roles add constraint teacher_roles_scope_type_check_v2
      check (scope_type in ('school','grade','class','subject','grade_subject'));
  end if;
  if exists (
    select 1 from pg_constraint
     where conrelid = 'teacher_roles'::regclass and conname = 'teacher_roles_scope_type_check'
  ) then
    alter table teacher_roles drop constraint teacher_roles_scope_type_check;
  end if;
end $$;

-- ③ 🔑 新列：学科代码（只有 scope_type in ('subject','grade_subject') 才有意义）。
--    为什么是**新列**而不是复用 scope_id：`scope_id` 是 uuid，学科代码是文本（'physics'）——
--    类型对不上，硬塞要转型、转完不可读。而"一个字段只能有一种语义"是本仓库的头号纪律。
alter table teacher_roles add column if not exists subject_code text;

-- ④ 唯一索引重做（先建新的、再删旧的）。
--    旧索引不含 subject_code → 同一个老师同时是"物理教研组长"和"化学教研组长"会被拒。
create unique index if not exists teacher_roles_unique_v2 on teacher_roles (
  teacher_id,
  role,
  coalesce(scope_type, ''),
  coalesce(subject_code, ''),
  coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
drop index if exists teacher_roles_unique;

-- ⑤ 组长两档的唯一位次（**部分唯一索引**，照年级主任那条的写法）：
--    教研组长 = **一个学科一个**（跨年级，所以不带 scope_id）；
--    备课组长 = **一个年级一个学科一个**（Q5 拍板；一个人可以管两个年级的同一科 = 两行，合法）。
--    ⚠️ 建之前**必须先清洗历史数据**：有重复行时建索引会直接失败（查重 SQL 见 §10.1.2）。
create unique index if not exists teacher_roles_one_subject_lead
  on teacher_roles (coalesce(subject_code, '')) where role = 'subject_lead';
create unique index if not exists teacher_roles_one_lesson_prep_lead
  on teacher_roles (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
                    coalesce(subject_code, ''))
  where role = 'lesson_prep_lead' and scope_type = 'grade_subject';

-- ⚠️ 年级主任那条唯一约束（Q25=B「一个年级一个年级主任」）**不在这里** ——
--    它不是本轮的拍板项，且加它同样要先清洗历史数据。见方案 §6.3。

-- -------- 10.1.2 🆕 迁移前后的查重 SQL（跑完**每一行都必须是 0**）--------
--  这是 §10.1.1 那三条唯一索引的护栏：有重复行时 `create unique index` 会失败，
--  而失败发生在 `db.exec(整份 schema.sql)` 里 → 整段回滚，不会留下半截状态。
--
--  select '老师-角色-范围-学科 重复' as 检查项, count(*) as 应为0
--    from (select teacher_id, role, coalesce(scope_type,''), coalesce(subject_code,''),
--                 coalesce(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)
--            from teacher_roles group by 1,2,3,4,5 having count(*) > 1) x
--  union all
--  select '一个学科多个教研组长', count(*)
--    from (select subject_code from teacher_roles
--           where role='subject_lead' group by subject_code having count(*) > 1) y
--  union all
--  select '一个年级一个学科多个备课组长', count(*)
--    from (select scope_id, subject_code from teacher_roles
--           where role='lesson_prep_lead' and scope_type='grade_subject'
--           group by scope_id, subject_code having count(*) > 1) z
--  union all
--  select '组长没有学科代码（= 判据永远匹配不到，看起来"指派成功了"其实没生效）', count(*)
--    from teacher_roles
--   where role in ('subject_lead','lesson_prep_lead') and coalesce(subject_code,'') = ''
--  union all
--  select '组长/备课组长的 scope 形状不对', count(*)
--    from teacher_roles
--   where (role='subject_lead'      and scope_type <> 'subject')
--      or (role='lesson_prep_lead'  and scope_type <> 'grade_subject')
--  union all
--  select '年级主任的 scope_id 指向不存在的年级', count(*)
--    from teacher_roles r where r.role='grade_head' and r.scope_type='grade'
--     and not exists (select 1 from grades g where g.id = r.scope_id)
--  union all
--  select '班主任的 scope_id 指向不存在的班', count(*)
--    from teacher_roles r where r.role='head_teacher' and r.scope_type='class'
--     and not exists (select 1 from classes c where c.id = r.scope_id);

-- -------- 10.1.3 🆕 回退 SQL（整段，出问题时跑）--------
--  🔴 **回退的第一步永远是"先处理数据、再改约束"** —— `check` 约束加不回去，
--     只要表里还有新代号的行。顺序反了会直接报错。
--
--  -- ① 先删掉新代号的行（**这一步不可逆，先导出一份**）
--  -- delete from teacher_roles where role in
--  --   ('principal','vice_principal','principal_assistant','office_head',
--  --    'moral_edu_head','subject_lead','lesson_prep_lead');
--  -- ② 再改约束/索引
--  -- drop index if exists teacher_roles_one_subject_lead;
--  -- drop index if exists teacher_roles_one_lesson_prep_lead;
--  -- drop index if exists teacher_roles_unique_v2;
--  -- create unique index if not exists teacher_roles_unique on teacher_roles (
--  --   teacher_id, role, coalesce(scope_type,''),
--  --   coalesce(scope_id,'00000000-0000-0000-0000-000000000000'::uuid));
--  -- alter table teacher_roles drop constraint if exists teacher_roles_scope_type_check_v2;
--  -- alter table teacher_roles add constraint teacher_roles_scope_type_check
--  --   check (scope_type in ('school','grade','class'));
--  -- alter table teacher_roles drop constraint if exists teacher_roles_role_check_v2;
--  -- alter table teacher_roles add constraint teacher_roles_role_check
--  --   check (role in ('super','grade_head','head_teacher','admin','teacher'));
--  -- ⚠️ `subject_code` 那一列**不要 drop**：留着不影响任何东西（全是 null），
--  --    而 drop 之后再想加回来要重新走一遍迁移。

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
--  真实情况（用户 2026-09-24 确认）：教师有两位 —— 一位物理老师（高二(1)班 / 高二(4)班 的
--  **任课老师，不是班主任**）和一个测试账号；班级三个（含一个「测试专用」）。
--  ⚠️ 真名只存在于**库里那一行**（`teachers.name`），**仓库里一律不写真人姓名**
--     —— 本文件是公开的。下文一律用「示例教师」指代他。
--  设计 §七 里记的「一位教师 / 两个班 / 2 份作业」是 09-23 的快照，早已过时。

-- ① 学校：优先沿用 teachers.school 里已经填过的名字，没有才用默认
--  ⚠️ 下面那个默认名是**中性占位**（`示例中学`），它只在「**新库** + `teachers.school` 也是空」时才会被用到：
--     整句被 `where not exists (select 1 from schools)` 守着 —— **线上库已经有 schools 行了，
--     这条永远是 no-op（改不到线上数据）**。所以「把默认名换掉」不涉及任何已建好的库：
--     真名留在各自的库里，由部署方自己维护。
--     新库想直接用真名：把 `示例中学` 换掉，或先给 `teachers.school` 填上（那一支优先）。
insert into schools (name)
select coalesce(
  (select nullif(school, '') from teachers where school <> '' limit 1),
  '示例中学'
)
where not exists (select 1 from schools);

-- ② 三个年级
--  ⚠️ 判据是 `where not exists`，**不能写 `on conflict do nothing`**：
--     §28.7 把按 `(school_id, name)` 的唯一索引 drop 掉了（届才是唯一键），
--     再跑本段时 `on conflict` 会报 `42P10`（没有能匹配的唯一索引）→ 整份脚本跑不过去。
insert into grades (school_id, name)
select s.id, g.name
from schools s
cross join (values ('高一'), ('高二'), ('高三')) as g(name)
where not exists (
  select 1 from grades x where x.school_id = s.id and x.name = g.name
);

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
--    当时以为库里只有一位教师、而且他就是管理员。
--    实际不是：那位老师只是任课教师，库里还有测试账号，真正的主管另有一个专用账号
--    （用户 2026-09-24 决定：**最高管理员只留一个**）。
--    「按拥有班级的人自动提权」这条规则尤其危险：它会顺手把任何一个建过班的老师
--    变成全校可见 —— 那不是权限设计，那是漏洞。所以超管必须**显式指派**，见 §10.6。

-- ⑥ 班主任：**不回填**。
--    旧模型里 classes.teacher_id 的含义是「这条班级记录是谁建的」，
--    **不等于班主任** —— 本项目里那位老师只是这两个班的物理老师，不是班主任
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
    -- 最高管理员 / 教务处：全校
    exists (select 1 from teacher_roles r, me
             where r.teacher_id = me.uid and r.role in ('super','admin'))
    -- 🆕 校级三档（校长 / 副校长 / 校长助理）与德育处主任：**全校只读**
    --    （方案 §三 第 1 行；三档在数据库里逐格相同，见 §10.1 的第 ④ 条纪律）
    --    ⚠️ 这一支**只放宽"读"**：写的那几个判据（can_manage_class / can_grade_subject /
    --       can_edit_exam）**一个字都没加它们** —— 读得宽、写得窄。
    or exists (select 1 from teacher_roles r, me
                where r.teacher_id = me.uid
                  and r.role in ('principal','vice_principal','principal_assistant','moral_edu_head'))
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
--          / 3 行任课关系（物理老师 × 物理 × 高二(1)、高二(4)；测试账号 × 物理 × 测试专用）
select '学校' as 表, count(*)::text as 行数 from schools
union all select '年级', count(*)::text from grades
union all select '班级', count(*)::text from classes
union all select '角色-super', count(*)::text from teacher_roles where role = 'super'
union all select '角色-班主任', count(*)::text from teacher_roles where role = 'head_teacher'
union all select '任课关系', count(*)::text from class_subjects;

-- ③ 🔴 新旧策略对比（阶段 5 的放行条件）
--    把 uuid 换成要核对的教师 id（教师 id 用 select id, name, subject from teachers; 拿）
--    ⚠️ 下面写的是**占位**（原先这里是维护者本人的教师 id —— 本文件是公开的，已移除）。
--       不换成真人就跑：CTE 是空集 → 判据**全部为 false**（假失败），§15.4 记过这个坑。
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
--     已验证（用户实跑）：对那位物理老师，visible_class_ids_for() 与旧策略 teacher_id = auth.uid()
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
--  ⚠️ 这里**曾经有一列 `can_stream`（走班候选）**：**P7 已把它删掉**（见 §32.6）。
--     理由：它和代码里的走班四科常量说的是**同一件事**，而库里标的只有 3 科（漏了化学）
--     → "两个真相"。走班四科现在**只认** `app/src/lib/stream.ts` 的 `STREAM_SUBJECT_CODES`。
create table if not exists subjects (
  code       text primary key,          -- 'chinese' / 'math' / 'physics' …
  name       text not null,             -- 语文 / 数学 / 物理 …
  short      text not null default '',  -- 两个字短名，手机上用
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
insert into subjects (code, name, short, sort) values
  ('chinese',       '语文',     '语',  1),
  ('math',          '数学',     '数',  2),
  ('english',       '英语',     '英',  3),
  ('physics',       '物理',     '物',  4),
  ('chemistry',     '化学',     '化',  5),
  ('biology',       '生物',     '生',  6),
  ('politics',      '政治',     '政',  7),
  ('history',       '历史',     '史',  8),
  ('geography',     '地理',     '地',  9),
  ('it',            '信息技术', '信', 10),
  ('general_tech',  '通用技术', '通', 11),
  ('pe',            '体育',     '体', 12),
  ('music',         '音乐',     '音', 13),
  ('art',           '美术',     '美', 14),
  ('mental_health', '心理健康', '心', 15)
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

-- ③ 字典本身（应该是 15 行）
--    ⚠️ P7 起**没有 `can_stream` 这一列**了（走班四科写死在 `app/src/lib/stream.ts`，见 §32.6）：
--       这一条 SQL 里再写它就会是 `42703 column does not exist`。
select code, name, short, sort from subjects order by sort;

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

-- -------- 13.2.1 🔴 拆函数：**建号 ≠ 指派身份**（2026-09-28，方案 §三.4 的 N-1）--------
--  用户拍板的新架构里，**唯一变宽的写权限**是「办公室主任建号」。
--  而 `can_manage_teachers()` 今天**同时**管三件事：建号 / 维护任课关系 / **指派身份**。
--  → 直接给它加 `office_head`，**办公室主任就能给自己发一条 `super`**。
--
--  所以先拆：一处判据变两个函数、两种语义（这正是 I17 那条纪律的用法）。
--    `can_create_teacher_accounts_for`  建号 / 维护任课关系 / 重置密码
--    `can_assign_roles_for`             **指派身份**（班主任 / 年级主任 / 组长 / 校级…）
--  🔴 两个函数**必须同时存在**：`/api/teacher-account` 的 `create/assign/reset` 动作
--     问前者、`role` 动作问后者。少了任何一个，"建号"与"指派身份"就会短暂地对不上。
--
--  ⚠️ `can_manage_teachers()` 那两个函数**保留、语义不变**（super + admin）——
--     它是"能管理教师账号"的**最宽**判据，旧调用方（如果有）行为一个字不变。
--     新增的两个是**更窄/更宽各一**：create 更宽（多一档 office_head）、assign 更窄（就是原来那个）。
create or replace function public.can_create_teacher_accounts_for(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from teacher_roles r
    where r.teacher_id = p_uid
      and r.role in ('super', 'admin', 'office_head')  -- 🆕 办公室主任：**只能建号**
  );
$$;

create or replace function public.can_assign_roles_for(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from teacher_roles r
    where r.teacher_id = p_uid
      and r.role in ('super', 'admin')   -- 🔴 **一个字都没加** —— 办公室不在里面
  );
$$;

revoke all on function is_super_admin_for(uuid)   from public, anon, authenticated;
revoke all on function can_manage_teachers_for(uuid) from public, anon, authenticated;
revoke all on function can_create_teacher_accounts_for(uuid) from public, anon, authenticated;
revoke all on function can_assign_roles_for(uuid) from public, anon, authenticated;

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

create or replace function public.can_create_teacher_accounts()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_create_teacher_accounts_for(auth.uid()) $$;

create or replace function public.can_assign_roles()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_assign_roles_for(auth.uid()) $$;

grant execute on function is_super_admin()     to authenticated;
grant execute on function can_manage_teachers() to authenticated;
-- 🔴 这两个也必须 grant 给 authenticated：`/api/teacher-account` 是**拿调用者自己的 JWT**
--    去 `POST /rest/v1/rpc/<函数名>` 问的（auth.uid() 就是调用者）。
--    不 grant 的话服务端会拿到 42501，而 `rpcBool()` 把它读成 `false` →
--    症状是"办公室主任点了建号，被告知没权限"，**而数据库里那条判据其实是对的**。
grant execute on function can_create_teacher_accounts() to authenticated;
grant execute on function can_assign_roles() to authenticated;

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
    -- 最高管理员 / 教务处：全校全科
    exists (select 1 from teacher_roles r
             where r.teacher_id = p_uid and r.role in ('super', 'admin'))
    -- 🆕 校级三档 + 德育处主任：全校全科（只读视角的"看得到"那一半，见 §10.3 visible_class_ids_for）
    or exists (select 1 from teacher_roles r
                where r.teacher_id = p_uid
                  and r.role in ('principal','vice_principal','principal_assistant','moral_edu_head'))
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

-- -------- 13.3.1 🆕 组长两档的**只读**学科视角（2026-09-28）--------
--  来源：`管理架构与角色权限方案.md` §五.5（**本方案风险最高的一处**）+ 用户 Q4 拍板
--  「组长不能改别人班本科的成绩」。
--
--  🔴 它**绝不能**加进 `visible_class_ids()` —— 这是这一整段最要紧的一句话：
--     `visible_class_ids()` 是"**看得见这个班**"的总开关，`students_visible` /
--     `calls_visible` / `schedule_class_visible` / `shared_files_class_read` /
--     `classroom_accounts_read` **全都挂在它上面**。加进去，组长就会顺带看到
--     那些班的**学生名册、呼叫记录、班级课表、同事共享的文件** ——
--     而他要的只有"**本科**的作业与成绩"。
--     **"看得见这个班"与"看得见这个班的这一科"是两件事**
--     （这正是 §13.3 把 `can_view_all_subjects` / `teaches_subject` 拆成两个函数的原话）。
--
--  🔴 它与 `visible_class_ids()` 是**并列**关系，不是包含关系：
--     策略里写成 `class_id in (select visible_class_ids()) and 这一科` 是**错的**
--     （那样组长看不到本学科别的班）；写成 `class_id in (select subject_lead_class_ids())`
--     而**不**再限定"这一科"也是**错的**（那样组长会看到别的科）。
--     正确的形状见 §13.4 / §15.3 里那两处 `or`。
--
--  🔴 **写策略一条都不加**（I19）：组长只能读。反向对照见 `rls-checks.mjs`：
--     "组长改本学科别班的成绩 → 必须被拒"。
--
--  语义：
--    · 教研组长 `subject_lead`     + `scope_type='subject'`       → 本校这个学科**开了课的所有班**（跨年级）
--    · 备课组长 `lesson_prep_lead` + `scope_type='grade_subject'` → **本年级**这个学科开了课的所有班
--  ⚠️ "哪些班开了这一科"来自 `class_subjects`（任课关系），**不是**"哪些班我任课"。
--     一个组长的名字可能根本不在 `class_subjects` 里（他只管教研、不带那个班的课）。
create or replace function public.subject_lead_class_ids_for(p_uid uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id
  from classes c
  where
    -- 教研组长：本校这个学科的所有班（跨年级）
    exists (
      select 1 from teacher_roles r
       where r.teacher_id = p_uid and r.role = 'subject_lead'
         and r.scope_type = 'subject'
         and coalesce(r.subject_code, '') <> ''
         and exists (select 1 from class_subjects cs
                      where cs.class_id = c.id and cs.subject_code = r.subject_code)
    )
    -- 备课组长：本年级这个学科
    or exists (
      select 1 from teacher_roles r
       where r.teacher_id = p_uid and r.role = 'lesson_prep_lead'
         and r.scope_type = 'grade_subject'
         and r.scope_id = c.grade_id
         and coalesce(r.subject_code, '') <> ''
         and exists (select 1 from class_subjects cs
                      where cs.class_id = c.id and cs.subject_code = r.subject_code)
    );
$$;

revoke all on function subject_lead_class_ids_for(uuid) from public, anon, authenticated;

create or replace function public.subject_lead_class_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$ select * from subject_lead_class_ids_for(auth.uid()) $$;

grant execute on function subject_lead_class_ids() to authenticated;

-- 我管的那些**学科代码**（教研组长按 subject_code；备课组长按本年级那个 subject_code）。
--  两档共用它 —— 用户拍板"教研组长 = 备课组长，权限逐格相同"，所以判据也只有一处。
--  ⚠️ 它返回的是**代码集合**，不是"哪些班"：策略里必须两个条件**同时**成立
--     （班在 subject_lead_class_ids 里 **且** 这份档案的学科在这张集合里），
--     少了后半句就是"组长看得到别科"——那是权限事故。
create or replace function public.subject_lead_subject_codes_for(p_uid uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct r.subject_code
  from teacher_roles r
  where r.teacher_id = p_uid
    and coalesce(r.subject_code, '') <> ''
    and (
      (r.role = 'subject_lead'      and r.scope_type = 'subject')
      or (r.role = 'lesson_prep_lead' and r.scope_type = 'grade_subject')
    );
$$;

revoke all on function subject_lead_subject_codes_for(uuid) from public, anon, authenticated;

create or replace function public.subject_lead_subject_codes()
returns setof text
language sql
stable
security definer
set search_path = public
as $$ select * from subject_lead_subject_codes_for(auth.uid()) $$;

grant execute on function subject_lead_subject_codes() to authenticated;

-- 「这一科是不是我管的其中一科」——`subject_code` 与显示名 `subject` 双读，
--  与 `teaches_subject_for` 的兼容期口径**逐字相同**（新列优先、认不出就按显示名查字典）。
--  ⚠️ 认不出来 = 不匹配（不猜）：猜错会让一位组长**看不到**本学科的档案，而且不报错。
create or replace function public.leads_subject(p_subject_code text, p_subject text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from (
      select coalesce(
        nullif(btrim(coalesce(p_subject_code, '')), ''),
        (select s.code from subjects s where btrim(s.name) = btrim(coalesce(p_subject, '')))
      ) as code
    ) subj
    where subj.code is not null
      and subj.code in (select * from subject_lead_subject_codes())
  );
$$;

grant execute on function leads_subject(text, text) to authenticated;

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
    -- 🆕 组长两档：**本学科**（跨年级 / 本年级）的作业档案 —— **只读**（§13.3.1）
    --  ⚠️ 两个条件**必须同时**成立：光有班 = 组长会看到别科；光有学科 = 看到全校的。
    or (
      class_id in (select subject_lead_class_ids())
      and leads_subject(subject_code, subject)
    )
  );

-- 🔴 组长**写不了**任何作业档案（用户 Q4 拍板）—— 这一条不是靠"没加策略"，
--    而是靠 §16.3 的三条写策略里**没有一支**认组长：
--      assignments_insert / update 用 `can_grade_subject()`（super/admin + 本班本科研课老师）
--      assignments_delete 用 `teacher_id = auth.uid() or can_manage_class(...) or teaches_subject(...)`
--    三者都不含 subject_lead / lesson_prep_lead —— 它们**只在上面那条 select 策略里出现过**。
--    反向对照（`rls-checks.mjs` 第十九节）：组长改本学科**别班**的成绩 → 必须被拒。

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
--     ⚠️ 里面的 uuid 是**占位**（原先写着维护者本人的教师 id，已从公开仓库移除）。
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
  using (
    class_ids && (select array(select visible_class_ids()))
    -- 🆕 组长两档：**本学科**（跨年级 / 本年级）的考试 —— **只读**（§13.3.1）
    --  ⚠️ 与作业那一处**形状相同、含义不同**，别把两处抄成一句就完事：
    --     `exams.class_ids` 是**数组**（一次考试可能覆盖多个班），所以用 `&&` 而不是 `in`；
    --     学科那一边与 §13.4 逐字相同（`leads_subject`）—— 一个判据、两种容器。
    --  ⚠️ 这一支**不放松"读得宽"那条纪律**：任课老师 / 年级主任 / 班主任这些老身份
    --     走的仍是上面那一句（看得见这个班就读得到这次考试，**不限学科**）；
    --     组长是**新增**的一类读者，所以给他加的是"本学科"这个收窄的支。
    or (
      subject_code in (select subject_lead_subject_codes())
      and class_ids && (select array(select subject_lead_class_ids()))
    )
  );

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
  using (
    class_id in (select visible_class_ids())
    -- 🆕 组长两档：本学科那些班的分数行 —— **只读**。
    --  ⚠️ 这一条是"读得通"的兜底：`exam_scores` 没有学科列，所以判据只能落在
    --     "**那个班的这一科**"上（`exists` 拉回 exams 取 subject_code）。
    --     少了它，组长能看到考试档案却看不到分数 → 统计页整片是空的**而且不报错**
    --     （与 I20 那次"少了教室端那一支"是同一个坑，方向相反）。
    or exists (
      select 1 from exams e
       where e.id = exam_scores.exam_id
         and e.subject_code in (select subject_lead_subject_codes())
    )
  );

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

--  ② 写判据函数在真实数据上的表现（把 uuid 换成要核对的老师 id；下面是占位）
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
--     所以 `me` = 示例教师时看到 `测试账号 / 物理 / 测试专用 = false`，它的意思是
--     "**示例教师**改不了测试账号那一行"（正确），**不是**"测试账号改不了自己的班"。
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
--     · `shared_files` 另有 **§19**（2026-09-28，用户拍板 A）：**班级归属** `class_ids uuid[]`
--       + 一条按班的读策略（看得见这个班的人读得到本班的文件 —— 教室端那一半就靠它）
--       + 两条"只能发给自己的班"的归属写守卫。读矩阵见 `功能设计与不变量.md` §十九。
--       ⚠️ `shared_files_own` 仍然**一个字没动**：它给的那条读（自己传的）与 §19 的读是 **OR**。
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
--     ⚠️ 里面的 uuid 是**占位**（原先写着维护者本人的教师 id，已从公开仓库移除）。
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

--  ✅ **上面这件事已经在 §19（2026-09-28）修掉了** —— 下面这段留档留着，是为了说明
--     "当时为什么只收写、没动读"，别再照它去怀疑现在的行为：
--     `shared_files_own` 只给"自己传的那一行"，所以云端模式下
--     **教室端读不到老师上传的行**（教师 A 也读不到教师 B 的行）——
--     "教师端 → 教室端的文件互传"这条路在**读**这一侧本来就不成立（§9 的老形状）。
--     上一轮按用户口径只收紧"写"，**没有动读**（动读要另拍板、且要连着客户端一起改）。
--     用户 2026-09-28 拍板 A（**按班隔离 + 上传时从自己的教学班多选**）之后，
--     读这一侧由 **§19** 补齐：`shared_files_class_read`（看得见这个班的人读得到本班的文件）
--     + 两条归属写守卫（只能发给自己的班）。当时的影响记录见
--     `功能设计与不变量.md` §十七·补 的补.4 —— 那一节现在写的是「已修」。

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
--       `can_edit_exam(...)` 对**任何人**都返回 false（用户实测：两位教师 / 所有班全 false）。
--       于是"某位老师能不能建高二(1)班的物理考试"这个最基本的问题，当时**没有答案**；
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
--  §19.4 **`can_share_file_to_class_for(uuid, uuid)`** ← 2026-09-28 新增（文件能发给哪个班）
--  合计 **13 个**，**每一个后面都紧跟一句 `revoke all on function … from public, anon, authenticated`**。
--  新增判据时四样一起加：`_for` + 裸版 + revoke + rls-checks 里至少一条断言（否则就是"加了没人钉"）。
--
-- -------- 18.6 这一段跑完之后，前端会怎样（"SQL 没跑也不崩"）--------
--  · **没跑这一段**：前端行为一个字不变（本节不建对象）；
--  · **跑了这一段**：策略 / 前端 / 教室端全部与改动前逐字相同（`can_edit_exam` 的签名与语义都没变，
--    只是函数体改成转调 `can_edit_exam_for`）—— 多出来的只是"考试写判据第一次可以被验证"。
--  · 回退（幂等，两行）：把 §15.2 的薄包装正文换回原来的 `with me as (select auth.uid() as uid) …`，
--    再 `drop function if exists can_edit_exam_for(uuid, uuid[], text, text);`。

-- ============================================================
--  19. 共享文件的**班级归属**（2026-09-28）：教师端 → 教室端 的文件互传，**读**这一侧修通
--
--  来源：用户拍板 A —— 「一个老师可能会同时教几个班级，所以科任老师上传的时候
--        需要从自己的教学班中选择，也可以多选」。
--  §17.6 上一轮只收紧了**写**，读一个字没动，并把"读这一侧本来就不通"留了档
--  （见 §17.6 末尾那段）。**这一节就是那件事的收尾**。
--
--  为什么非修不可（上一轮 `npm run rls-checks` 实测出来的缺口，不是读代码猜的）：
--    `shared_files` 上**只有一条**策略 `shared_files_own`（§9）
--    = `for all ... teacher_id = auth.uid()`，意思是"只能看**自己传的**那一行"。后果两条：
--      · 教室端 `listFiles()` 拉到的**永远是空列表，而且不报错**（`Classroom.tsx`）——
--        本地演示模式看不出来（本地不走 RLS），**一到云端就是"传了但教室里看不见"**；
--      · 两位老师互相看不到对方给同一个班传的材料（同一张卷子得各传一次）。
--
--  ⚠️ 这一节**只做加法**：`shared_files_own` 的正文一个字不动（它一条 `for all` 同时给着
--     "读自己那行"与"写自己那行"两条路），§17.6 那三条"教室端不算教师"的 restrictive 也不动。
--     新增的是：一条**班级归属的读策略**、一个**归属判据**、两条把归属收在自己班里的写守卫，
--     外加**存储对象那一侧的读**放宽一次（19.4.3 —— 少了它，"行读通了、字节还是读不通"）。
--     本段可重复执行（幂等）。
--
--  -------- 19.1 数据模型：为什么是 `class_ids uuid[]` --------
--  三个候选，选第一个：
--    ① **`class_ids uuid[]`（选它）**：一个文件一行、一份存储对象，班级归属是**这一行的属性**。
--       "同一个课件传一次、几个班都能看"落到库里就是"这一行的数组里有几个班"。
--    ② 关联表 `shared_file_classes(file_id, class_id)`：更范式化，但代价是
--       a) 读策略要跨表 `exists`；b) `shared_files_own` 给不了关联表的权限，
--          得再给关联表写一整套读/写策略 —— **判据从一个变两个**（本项目反复踩过的坑，§十）；
--       c) 教室端每次列表都要多一次 join。这一节要修的是"读不通"，不值得顺手把判据拆成两处。
--    ③ 一个班一行（把文件摊成 N 行）：**直接排除**。云端那份存储对象只有一份，而教室端
--       "取回本机"是按行处理的 —— 第一个班取走就会牵动另一个班（"几个班都能看"当场不成立），
--       而且每行都要各算一次存储路径。
--
--  `class_ids` 的语义（**钉死，改它之前先读这里；回归也钉着它**）：
--    · **空数组 = 没有任何班级归属**：只有上传者自己看得见（教师端列表里显示「未指派班级」），
--      **教室端看不到** —— 这是**最安全**的那个解释。
--      ⚠️ §9 老列 `class_id` 那句注释（"为空 = 所有班级可见"）**从本节起作废**：
--      本节之后**没有任何策略、也没有任何前端代码读 `class_id`**（见 19.2）。
--    · 数组里出现"已删掉的班"的 id 是**无害**的：`&& visible_class_ids()` 匹配不上，
--      等于无归属，不会泄漏给任何人。
--    · 数组**建不了外键**（Postgres 的数组列不支持）—— 所以删班**不会**级联删文件行。
--      老列 `class_id` 的 `on delete cascade` 因此只对"那一列还写着这个班"的老行有效。
--      ⚠️ 这是**有意的**：删班（W30 连二次确认都没有）不该顺手删掉老师传上来的课件。
--      留下的"指向已删班"的 id 就是上一条说的无害形状；要清理跑 19.5 的自检 ③。
--
--  -------- 19.2 老数据：空归属 = 教室端看不到；只搬"老师明确选过的那一个班" --------
--  · `class_ids` 加列时带 `not null default '{}'` → **所有老行一律是"无归属"**（教室端看不到）。
--  · 唯一会被搬的是 `class_id` **非空**的老行 —— 那是老师上传时在旧下拉框里
--    **明确选过**的一个班（旧界面的默认值是"所有班级"= 空，所以非空的一定是手选的）。
--    **这不是猜**：
--      - 空的一律留空（旧语义"所有班级可见"从本节起作废；**绝不**解释成"所有班都发"，
--        那会把一份旧课件同时捅进每一个教室，"最安全"的选择就是不猜）；
--      - 非空的是一个**已经躺在库里的显式选择**。不搬的话，这些文件（以及"线上库还没跑本节时
--        上传的文件"，见 19.6 那条兼容路径）会在跑完本节之后**静默地**永远进不了教室 ——
--        而那正是这一节要修的那个毛病。
--  · 想改成"一个都不搬"？把下面那条 `update` 注释掉再跑即可。它的条件是
--    `class_ids = '{}'`，而新前端**不再写 `class_id`**（那一列从此一直是 NULL），
--    所以"`class_id` 非空 + `class_ids` 为空"这种形状只可能来自"本节还没跑时的老形状"——
--    重跑这条 `update` 只会把它们补上，不会覆盖老师故意留空的归属。
--
--  -------- 19.3 读策略：看得见这个班的人，就看得见这个班的文件 --------
--  🔴 判据用 `visible_class_ids()`（**同一件事只有一个判定入口**）：
--    · 教室端 → 它的班（§10.3 `visible_class_ids_for` 里"教室端：本班"那一支）；
--    · 任课老师 → 他任教的班（同一个函数里 `class_subjects` 那一支）；
--    · 班主任 / 年级主任 / 教导处 / 超管 → 各自"看得见"的范围（**读得宽**，
--      与 `assignments_visible` / `students_visible` / `calls_visible` 完全同一口径）。
--    换成"只给任教老师"（`teaches_in_class`）是**另一套口径**：班主任打开本班材料会什么都看不到，
--    而且它和"班级列表里看得见的班"从此分叉 —— 本项目最忌讳的那种分叉。
--  ⚠️ 这里**没有**新写 `_for` 判据：复用的是既有判据（I33 要求的是"**新增**判据要两件套"）。
--
--  -------- 19.4 写的守卫：**只能把文件归到自己看得见的班**（判据在数据库，不在前端）----
--  19.4.1 判据 `can_share_file_to_class()` = "这个班在**我的班级列表**里"，
--         定义与 `classes_visible`（§16.3.0）**逐字同款**：
--         `id in (select visible_class_ids()) or teacher_id = auth.uid()`。
--  🔴 **为什么必须同款**：上传界面里的班级列表就是 `store.classes` = 数据库按
--     `classes_visible` 筛过的那一份（§11.3「前端不另写过滤」）。两边只要差一支，
--     就会出现"列表里有这个班、勾了它却存不进去（RLS 报错）"——**同一件事两个判定入口**的
--     典型症状。反面同样要防：写判据比读宽 = "能把文件发给自己看不见的班"，
--     而教室端会照单全收（那块屏是给学生看的）。
--  🔴 **为什么写这一层**（而不是"前端只列自己的班就够了"）：§17.2 裂缝 B 的结论——
--     前端走不到不等于策略清单上成立，而策略清单是这个项目的安全边界说明书。
--     `shared_files_own` 只要求"行是我的"，**不关心**归属写给谁；不补这一层，
--     任何一位老师都能把文件归到任意一个班（一份没有判据的写入路径）。
--
--  -------- 19.5 自检（把下面整段粘进 SQL 编辑器跑）--------
--  ① 这次搬迁动了什么（跑本节**之前**先看一眼预期，跑完再对一眼）：
-- select '有明确班级归属（class_id 非空）的老文件' as 检查项, count(*)::text as 值
--   from shared_files where class_id is not null
-- union all
-- select '其中 class_ids 已填上（跑过本节）', count(*)::text from shared_files
--   where class_id is not null and class_ids <> '{}'::uuid[];
--  ② 现在"教室端看不到"的文件有几份（空归属 = 只有上传者自己看得见）：
-- select f.id, f.name, t.name as 上传者 from shared_files f
--   left join teachers t on t.id = f.teacher_id
--  where coalesce(f.class_ids, '{}'::uuid[]) = '{}'::uuid[] order by f.created_at desc;
--  期望：跑完本节之后这里只剩"老师故意没选班"的那些 —— 每一条在教师端上传页里都写着「未指派班级」。
--  ③ 归属指向了已删的班（无害，教室端谁也看不到；要清理就删掉这些 id）：
-- select f.id, f.name, f.class_ids from shared_files f
--  where exists (select 1 from unnest(f.class_ids) as cid
--                 where not exists (select 1 from classes c where c.id = cid));
--  ④ 逐人核对"谁能看见哪些文件"（`_for` 变体的用处，见 §18.1）：
-- select t.name as 老师,
--        (select count(*) from shared_files f
--          where coalesce(f.class_ids,'{}'::uuid[]) && array(select visible_class_ids_for(t.id))) as 他看得见的文件数
--   from teachers t order by 1;
--
--  -------- 19.6 这一段跑之前 / 跑之后，前端会怎样（"SQL 没跑也不崩"）--------
--  与 §12.4 / §15.6 同一套纪律，落在 `app/src/lib/files.ts` 的 `ensureFileClassCols()`：
--   · **没跑本节**：探测到 `class_ids` 这一列不存在 →
--        - 写：**不带**这一列（带上一列不存在的列，整条 insert 会被 PostgREST 拒掉，
--          而本项目是"保存失败 = 刷新即丢"），改**只带老列 `class_id`**（单个班时）；
--          选了**两个以上**的班 → **明确报错**，绝不静默只存一个（19.5 ② 那种"以为发出去了"最坏）；
--        - 读：`select('*')` 读不到那个键**不报错**，`classIds` 兜底成空数组；
--        - 教室端照旧看不到老师的文件 —— 这正是本节要修的那半边，跑之前别指望它好。
--   · **跑了本节**：教室端只见本班；教师见得"自己传的 ∪ 自己班的"（**含同事传的，而且点得开** ——
--     19.4.3 那一支就是给"点得开"用的）；多选生效。**前端一行都不用改**（探测自动切换）。
--
--  -------- 19.7 回退（幂等）--------
-- drop policy if exists shared_files_class_read on shared_files;
-- drop policy if exists shared_files_class_scope_insert on shared_files;
-- drop policy if exists shared_files_class_scope_update on shared_files;
-- drop index if exists shared_files_class_ids_idx;
-- drop function if exists can_share_file_to_class(uuid);
-- drop function if exists can_share_file_to_class_for(uuid, uuid);
-- 列可以留着（前端探到列在就会写它，留着不影响任何权限）；
-- 但要让教室端重新看不见，**读策略那一条必须删掉**。
-- ⚠️ 存储那一条（19.4.3）要单独回退：把 §9 的 `classroom_files_read` 正文
--    （`drop policy` + `create policy` 两句）**重新跑一遍**即可 —— 它是幂等的。
--
--  -------- 19.8 这一段**不做**什么（免得后来的人以为漏了）--------
--  · `shared_files_own`、§17.6 三条 restrictive **一个字没动**；
--    存储那一侧**只放宽了读**（19.4.3）：`classroom_files_insert` / `classroom_files_delete`
--    两条写策略**原样**，对象的路径约定 `{teacher_id}/…` 也没变；
--  · **不做**"教室端取走之后自动删云端那一行"：教室端是**零写权限**（§17.6，用户拍板），
--    它删不掉那一行（DELETE 被策略筛成 0 行，而且**不报错**），**也删不掉桶里那份对象**。
--    所以本节之后云端那份会**留着** —— 多班共用本来也必须留着。教师端「教室端文件」里的
--    删除按钮是唯一的清理入口，上传页的老文案"教室里取走后就从云端删除"已按实际改掉
--    （见 `功能设计与不变量.md` §十九）；
--  · **不做**"哪台教室端取过了"的追踪（要教室端写标记 = 又给它写权限）；
--  · **不做**走班 / 教学班（阶段 4）：这里只认 `classes`（行政班），与 §16.9 第 7 条的留档一致；
--  · **不做**"给无归属的老文件自动找一个班"（19.2 只搬 `class_id` 非空那一批，其余留空）。
-- ============================================================

-- -------- 19.1 加列（幂等）+ 索引 --------
-- `not null default '{}'` 一次到位：**老行全部落到"无归属"**（教室端看不到，19.2）。
alter table shared_files
  add column if not exists class_ids uuid[] not null default '{}';

-- 归属数组的查询用 `&&`，给它一个 GIN 索引
create index if not exists shared_files_class_ids_idx on shared_files using gin (class_ids);

-- -------- 19.2 搬迁：只搬"老师明确选过的那一个班"（class_id 非空）--------
update shared_files
   set class_ids = array[class_id]
 where class_id is not null
   and coalesce(class_ids, '{}'::uuid[]) = '{}'::uuid[];

-- -------- 19.3 读：本班的文件，教室里那块屏要看得到 --------
--  这是本节的核心一条。**没有 SELECT 之前，教室端的文件列表恒为空且不报错。**
--  ⚠️ 它是 permissive（默认）—— 与 `shared_files_own` 之间是 **OR**：
--     "自己传的"（老路）∪"自己班的"（新路），一条都没被拿掉。
drop policy if exists shared_files_class_read on shared_files;
create policy shared_files_class_read on shared_files
  for select to authenticated
  using (coalesce(class_ids, '{}'::uuid[]) && array(select visible_class_ids()));

-- -------- 19.4 写：归属只能落在"我看得见的班"上 --------
--  19.4.1 判据**两件套**（I33：`_for` 是函数体、显式传人、**一律 revoke**；
--         裸版读 `auth.uid()`，策略**只准**引用裸版）。
--  ⚠️ 顺序：`create policy` 会**当场解析函数名**（§18.4 有实测），所以判据必须建在下面两条策略之前。
create or replace function public.can_share_file_to_class_for(p_uid uuid, p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from classes c
     where c.id = p_class_id
       -- 与 classes_visible（§16.3.0）**逐字同款**：看得见这个班 · 或者这个班是我建的
       and (c.id in (select visible_class_ids_for(p_uid)) or c.teacher_id = p_uid)
  );
$$;

revoke all on function can_share_file_to_class_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.can_share_file_to_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_share_file_to_class_for(auth.uid(), p_class_id) $$;

grant execute on function can_share_file_to_class(uuid) to authenticated;

--  19.4.2 两条**逐动作 restrictive**（insert / update）：**AND 上去**，不放宽任何东西。
--  ⚠️ 与 §17 同一个理由：**不拆** `shared_files_own` 那条 `for all`
--     （拆 OR 漏一个动作 = "老师传完文件、刷新即丢且不报错"，§16.3 发现一）。
--  ⚠️ **不含 SELECT**：restrictive 的 `using` 对 SELECT 同样生效，写成一条 `for all`
--     会把"读"一起改掉（裂缝 A 就是这么踩的，§7.5 坑 1）。
--  ⚠️ `bool_and` 对**空数组**是 NULL → `coalesce(..., true)`：不选班是合法状态（无归属）。
drop policy if exists shared_files_class_scope_insert on shared_files;
create policy shared_files_class_scope_insert on shared_files
  as restrictive
  for insert to authenticated
  with check (
    (select coalesce(bool_and(can_share_file_to_class(cid)), true)
       from unnest(coalesce(class_ids, '{}'::uuid[])) as cid)
  );

drop policy if exists shared_files_class_scope_update on shared_files;
create policy shared_files_class_scope_update on shared_files
  as restrictive
  for update to authenticated
  using (
    (select coalesce(bool_and(can_share_file_to_class(cid)), true)
       from unnest(coalesce(class_ids, '{}'::uuid[])) as cid)
  )
  with check (
    (select coalesce(bool_and(can_share_file_to_class(cid)), true)
       from unnest(coalesce(class_ids, '{}'::uuid[])) as cid)
  );

-- -------- 19.4.3 🔴 存储那一侧：对象的**读**要跟着表走（不然"行读通了、字节读不通"）--------
--  这是"教室端读不到老师上传的文件"的**另一半**，别漏：
--    §9 的桶策略 `classroom_files_read` 只允许读**自己目录**下的对象
--    （`(storage.foldername(name))[1] = auth.uid()`），而老师传的文件放在 `{老师的 uid}/…` 下面 ——
--    于是教室端就算**读得到 `shared_files` 那一行**（19.3 的读策略），
--    `createSignedUrl()` 也签不出直链：`files.ts` 的 `signedUrl()` 出错返回 null
--    → `fetchBlob()` 返回 null → 教室里那一行**永远停在「待取回」，而且不报错**。
--    （列表里看得见、点开没反应 —— 本项目最忌讳的那类"看起来正常其实坏了"。）
--    `Files.tsx` 里老师点**同事**那一份的「打开」走的也是这条路，同样会被挡。
--
--  写法：**读哪个对象 = 读不读得到指向它的那一行** —— 把判据**委托**给 19.3，不另写一套：
--      自己的目录  ∪  `shared_files` 里有一行的 `storage_path` 就是它（子查询以当前登录者求值，
--      自动带上 `shared_files` 自己的 RLS）。
--  所以"教室端看得见本班、老师看得见自己任教班"这套口径**自动一致**：
--  以后改 19.3 不用回来改这里（同一件事只有一个判定入口）。
--  ⚠️ **写（insert / delete）一个字没动**：还是只能在自己目录下动 ——
--     教室端**依旧不能**往桶里写任何东西、也不能删老师那份对象（它删不掉，见 19.8）。
--  🔴 **`f.storage_path = objects.name` 那个限定词不能省**（实测踩过）：
--     `shared_files` 自己有一个 `name` 列，写成不带限定的 `= name` 时，
--     SQL 会把它解析成**子查询里那个** `f.name`（就近作用域）→ 条件恒假 →
--     整条 EXISTS 永远不成立，而**一条错都不报**（对象就是读不到，症状和没改一样）。
drop policy if exists classroom_files_read on storage.objects;
create policy classroom_files_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'classroom-files'
    and (
      -- ① 自己目录下的（§9 的老规矩，原样保留：连"元数据行已经删掉、对象还在"的孤儿也读得到）
      (storage.foldername(name))[1] = auth.uid()::text
      -- ② 或者：这一份文件在 shared_files 里有一行**我读得到**（判据就那么一处，见 19.3）
      or exists (select 1 from shared_files f where f.storage_path = objects.name)
    )
  );

-- 赋权与 §9 一致（这一节不新增任何 grant）。
-- ⚠️ 这里**故意不** grant 任何东西给 anon；`can_share_file_to_class_for` 已 revoke。

-- ============================================================
--  20. 序列号键迁移（P1，2026-09-25）
--      「每个学生一个全校唯一、生成后永久不可改的序列号」+
--      「那 10 个以学号为键的字段 + 两处考试字段的键**值迁移**到序列号」
-- ============================================================
--  为什么要有这一节（`年级管理与选科走班方案.md` §2.1 / §4.4，`选科走班实施计划.md` 的 P1）：
--   · 今天那 10 个字段的键是**班内学号**，而学号只在班内唯一（`unique (class_id, student_no)`）；
--   · 走班一上线，一个走班班里同时有 1 班的 3 人和 4 班的 33 人 → **两个"12 号"**
--     → `wrong = {"12": [...]}` 把两个孩子**静默合并**（本项目最忌讳的"看起来很正常"的失败模式）；
--   · 所以键换成**全校唯一**的 `students.serial`（Q6），**生成后永久不可改**，**由数据库强制**。
--
--  本节四件事（**全部幂等，可重复执行**）：
--    ① 加两列 + 唯一索引 + **DB 层强制"不可改"**（触发器，不是界面灰化）
--    ② 给存量学生生成序列号（生成的同时把**旧学号**存进 `legacy_student_no`）
--    ③ 键**值迁移**（列类型一个字节不改：仍是 `text[]` / `jsonb` —— Q6 明确"值迁移，不是改类型"）
--    ④ 自检函数 + 迁移前快照 + **回退函数**（回退脚本与正向脚本一起写、一起测）
--
--  🔴 **幂等的唯一根据是 `students.legacy_student_no`（待确认 U-3 的结论 = B）**，
--     **不是"猜键的形状"**：老方案那条判据（`key !~ '^[0-9a-f]{8}-'` = "不是 uuid 形状"）
--     **在序列号下失效** —— 序列号也是一串数字。
--     本节的口径：**"这个键能不能通过 `legacy_student_no` 反查到序列号、
--     而且它本身还不是本班任何学生的序列号"** —— 能，就是"还没迁"；不能，就是"迁过了 / 认不出"。
--     于是**重跑一遍，受影响行数 = 0**。
--     ⚠️ 为什么必须**存一列**而不是每次去读 `students.student_no`：**班内学号是可改的**
--        （Q6：班主任 / 年级主任 / 教导处三档都能改）→ 改过之后老键再也反查不出来。
--        `legacy_student_no` 是"**迁移那一刻的老键存档**"，**不是 `student_no` 的副本**。
--
--  ⚠️ **范围包含 `exams.absent_nos` 与 `exam_scores.student_no`**：它们不在用户点名的
--     "那 10 个"里，但**语义完全相同**（同样以学号为键）。不迁 = 同一个学生两套键
--     → 年级排名 / 缺考在迁移后对不上。**这一条是执行方按「一个字段只能有一种语义」+
--     「同一不变量要在所有写入路径上守」推定的**（`选科走班实施计划.md` §八 第 4 条已登记）。
--
--  ⚠️ **本节不做**什么（免得后来的人以为漏了）：
--     · **不删 `students.student_no`**、**不改 `unique (class_id, student_no)`**（Q6：班内学号照旧可改）；
--     · **不碰 `exams.grade` 文本、不加 `exams.grade_id`**（那是 Q33 / P2 的活）；
--     · **不碰 `assignments.class_id` 的 not null、不碰 `calls.assignment_id`**（Q21 / Q32 = P5 / P9）；
--     · **不新增任何 RLS 策略**："不可改"落在触发器上，比策略更硬（连 SQL 编辑器也拦）。
-- ============================================================

-- -------- 20.1 加列 + 唯一索引（幂等）--------
-- `not null default ''` 一次到位：老行全部落到"还没生成"（下面 20.3 补）。
alter table students add column if not exists serial text not null default '';
-- 迁移那一刻的**班内学号存档**（= 老键）。空串 = "不是从老键迁过来的"（建档时就有的新学生）。
alter table students add column if not exists legacy_student_no text not null default '';

-- 全校唯一：空串不参与（"还没生成"不是重复）。
create unique index if not exists students_serial_key on students (serial) where serial <> '';
-- 反查索引：键迁移按 `(class_id, legacy_student_no)` 查，几百行也要走索引
create index if not exists students_legacy_no_idx
  on students (class_id, legacy_student_no) where legacy_student_no <> '';

-- -------- 20.2 DB 层强制："序列号生成后永久不可改" --------
-- 为什么不用 `revoke update (serial)`：前端 upsert 的载荷里带着这一列，
-- 列级 revoke 会把**值没变的正常保存**也一起拒掉（"保存失败 = 刷新即丢"，§一）。
-- 触发器只说清一件事：**非空的序列号不许变成另一个值、也不许被清空**。
create or replace function public.students_serial_guard()
returns trigger
language plpgsql
as $$
begin
  -- ① 序列号：'' → 有值 = 允许（生成/回填）；有值 → 另一个值 / 清空 = **拒**
  if old.serial <> '' and new.serial is distinct from old.serial then
    raise exception '序列号生成后永久不可改（students.serial，见 选科走班问题清单 Q6）'
      using errcode = '23514';
  end if;
  -- ② 老键存档同理：它是**幂等的唯一根据**，被人改掉 = 迁移判据失效（而且不报错）
  if old.legacy_student_no <> '' and new.legacy_student_no is distinct from old.legacy_student_no then
    raise exception 'students.legacy_student_no 是迁移判据，写一次之后不许再改（见 schema.sql §20）'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists students_serial_guard on students;
create trigger students_serial_guard
  before update on students
  for each row execute function public.students_serial_guard();

-- -------- 20.2b 新建学生时自动发号（**所有写入路径**共用这一条规则，I16）--------
-- 为什么必须有它：建档 / 粘贴导入 / 拍照导入 / 备份恢复 / 手工 SQL —— 五条路径，
-- 少覆盖一条就会出现"这个学生没有键"，而那正是"转班/插班后档案对不上"的来源。
--
-- 🔴 **为什么还要一张计数器表**（`student_serial_counters`）：
--    一次性插入**多行**时（粘贴导入就是一次 upsert 几十行），BEFORE INSERT 触发器里
--    那句 `select max(serial)` **看不见同一条语句里刚插进去的行**（语句开始时取的快照）——
--    于是每一行都会算出**同一个号**，整批撞唯一索引。
--    计数器用 `insert … on conflict do update … returning` 取号：它在语句内**逐行**递增，
--    所以一次插 50 行也能拿到 50 个不同的号。
--    这一列同时兜住"有人手工插了一个更大的号"（`greatest` 会跳上去）。
--    ⚠️ 它**不是**"能推出来的状态存第二份"：它就是发号器本身，没有第二个真相。
create table if not exists student_serial_counters (
  year   text primary key,          -- 4 位入校年份
  last_n int  not null default 0    -- 这个届**已经发出去**的最大序号
);
alter table student_serial_counters enable row level security;
-- 只给触发器用（`security definer`），前端一个权限都不给：
-- 谁都能改它 = 谁能把号发重。
revoke all on table student_serial_counters from anon, authenticated;

-- ⚠️ 认不出入校年份时**留空 serial 并且不报错**（I14：认不出不许猜）——
--    报错会让"保存失败 = 刷新即丢"落到老师头上；留空则由自检函数报出来让人补数据。
-- ⚠️ `security definer`：它要读写上面那张**没有给任何角色权限**的计数器表。
--    函数体只做三件事：看这一行在不在、认年份、取号 —— 不返回任何别人的数据。
create or replace function public.students_serial_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year text;
  v_base int;
  v_n int;
begin
  if coalesce(new.serial, '') <> '' then
    return new;
  end if;
  /*
   * ⚠️ upsert（PostgREST 的 `on conflict (id) do update`）**也会走 BEFORE INSERT**：
   *    那一行本来就存在、本来就有序列号 —— 这里**不能再生成一个**，
   *    否则 BEFORE UPDATE 的守卫会当场把整条 upsert 拒掉（= 老师保存不了名单）。
   *    判据是"这一行在不在"（语句开始前的快照），不是"载荷里有没有值"。
   */
  if exists (select 1 from students s where s.id = new.id) then
    return new;
  end if;

  v_year := public.serial_year_of_class(new.class_id);
  if v_year = '' then
    return new;   -- 认不出 → 留空，等自检清单报出来（**不猜**）
  end if;

  -- 这个届**已经有**的最大序号（= "追加到年级末尾"的基准，U-2 = A）
  select coalesce(max((substr(s.serial, 5))::int), 0)
    into v_base
    from students s
   where s.serial ~ '^[0-9]{4}[0-9]{3}$'
     and left(s.serial, 4) = v_year;

  insert into student_serial_counters (year, last_n)
  values (v_year, v_base + 1)
  on conflict (year) do update
     set last_n = greatest(student_serial_counters.last_n, v_base) + 1
  returning last_n into v_n;

  if v_n is null or v_n > 999 then
    return new;   -- 3 位序号用完了（Q23 说每届 3 位够用）→ 留空 + 清单，不猜
  end if;

  new.serial := v_year || lpad(v_n::text, 3, '0');
  return new;
end;
$$;

drop trigger if exists students_serial_fill on students;
create trigger students_serial_fill
  before insert on students
  for each row execute function public.students_serial_fill();

-- -------- 20.3 入校年份从哪来（**唯一一处判定入口**，认不出就返回空串）--------
-- 顺序：① `grades.cohort`（P3 之后才有的列 —— 用 `to_jsonb` 兼容"列还没建"的库）
--       ② `grades.year`（**老列，注释就写着"2026 级"** —— 它本来就是"届"，§2.13.1）
--       ③ 按年级名在本校**唯一**匹配（同名多条 = 歧义 = **不认**，I14）
--       ④ 同年级**已有学生**的序列号前缀（**一致时**才算 —— 这是从数据里读出来的事实，不是猜）
-- ⚠️ **不用 `classes.year`**：那是"学年"（`2025-2026`），与"届"是两回事（§2.13.1 的教训）。
-- ⚠️ 前端 `lib/serial.ts` 是这条规则的**镜像**（顺序逐条相同）—— 两边改一处就要改两处，
--    所以前端那份只用于"本地演示模式"与"导入没有序列号的老备份"，云端一律以数据库为准。
create or replace function public.serial_year_of_class(p_class_id uuid)
returns text
language sql
stable
as $$
  with c as (
    select cl.id, cl.grade_id, cl.grade, cl.school_id
      from classes cl where cl.id = p_class_id
  ), direct as (
    select nullif(btrim(coalesce(to_jsonb(g) ->> 'cohort', '')), '') as cohort,
           nullif(btrim(coalesce(to_jsonb(g) ->> 'year',   '')), '') as year
      from c left join grades g on g.id = c.grade_id
  ), named as (
    select (select count(*) from grades gg
             where gg.school_id = c.school_id and gg.name = c.grade) as n,
           (select min(btrim(coalesce(to_jsonb(gg) ->> 'cohort', ''))) from grades gg
             where gg.school_id = c.school_id and gg.name = c.grade) as cohort,
           (select min(btrim(coalesce(to_jsonb(gg) ->> 'year',   ''))) from grades gg
             where gg.school_id = c.school_id and gg.name = c.grade) as year
      from c
  ), peers as (
    select distinct left(s.serial, 4) as y
      from students s
      join classes c2 on c2.id = s.class_id
     where c2.school_id = (select school_id from c)
       and c2.grade = (select grade from c)
       and s.serial ~ '^[0-9]{4}[0-9]{3}$'
  )
  select case
    when (select cohort from direct) ~ '^[0-9]{4}' then left((select cohort from direct), 4)
    when (select year   from direct) ~ '^[0-9]{4}' then left((select year   from direct), 4)
    when (select n from named) = 1
     and (select cohort from named) ~ '^[0-9]{4}' then left((select cohort from named), 4)
    when (select n from named) = 1
     and (select year   from named) ~ '^[0-9]{4}' then left((select year   from named), 4)
    when (select count(*) from peers) = 1 then (select y from peers)
    else ''      -- 认不出 → 空串（**不猜**）
  end
$$;

-- -------- 20.4 键的三态判定（**唯一一处判定入口**）--------
--   'empty'   —— 空键（不在例外集里的学生本来就不该有键；原样返回）
--   'serial'  —— 已经是本班某个学生的序列号   → **原样**（"重跑不动"就靠这一支）
--   'legacy'  —— 能通过 `legacy_student_no` 反查出序列号 → **要迁**
--   'unknown' —— 都查不到 → **留原键**（I14：认不出不许猜；进自检清单，人工判断）
-- ⚠️ 作用域是**班级**（那 10 个字段全都挂在一个班/一份档案上 —— §2.1 核对过的那条）。
--    两处考试字段的作用域见 20.6。
create or replace function public.serial_key_state_classes(p_class_ids uuid[], p_key text)
returns text
language sql
stable
as $$
  select case
    when p_key is null or p_key = '' then 'empty'
    when exists (
      select 1 from students s
       where s.class_id = any (coalesce(p_class_ids, '{}'::uuid[]))
         and s.serial <> '' and s.serial = p_key
    ) then 'serial'
    when exists (
      select 1 from students s
       where s.class_id = any (coalesce(p_class_ids, '{}'::uuid[]))
         and s.legacy_student_no <> '' and s.legacy_student_no = p_key
         and s.serial <> ''
    ) then 'legacy'
    else 'unknown'
  end
$$;

/** 单班版（10 个字段用）：薄包装，判据只有上面那一处 */
create or replace function public.serial_key_state(p_class_id uuid, p_key text)
returns text
language sql
stable
as $$ select public.serial_key_state_classes(array[p_class_id], p_key) $$;

/** 新键（序列号）；'unknown' 与 'empty' 一律**原样返回** */
create or replace function public.serial_key_of_classes(p_class_ids uuid[], p_key text)
returns text
language sql
stable
as $$
  select case public.serial_key_state_classes(p_class_ids, p_key)
    when 'legacy' then (
      select s.serial from students s
       where s.class_id = any (coalesce(p_class_ids, '{}'::uuid[]))
         and s.legacy_student_no = p_key and s.serial <> ''
       order by s.serial limit 1
    )
    else p_key
  end
$$;

create or replace function public.serial_key_of(p_class_id uuid, p_key text)
returns text
language sql
stable
as $$ select public.serial_key_of_classes(array[p_class_id], p_key) $$;

/** "这一行的这个键还没迁" —— **幂等 WHERE 的唯一根据** */
create or replace function public.serial_key_pending_classes(p_class_ids uuid[], p_key text)
returns boolean
language sql
stable
as $$ select public.serial_key_state_classes(p_class_ids, p_key) = 'legacy' $$;

create or replace function public.serial_key_pending(p_class_id uuid, p_key text)
returns boolean
language sql
stable
as $$ select public.serial_key_pending_classes(array[p_class_id], p_key) $$;

-- -------- 20.5 生成序列号（幂等：**只给 `serial = ''` 的学生**）--------
-- U-2 = A：同一届内**追加到末尾**（已用最大号 + 1），**不复用空号**。
-- ⚠️ "年级内首字母序"落地口径：**库支持 ICU 中文排序（`zh-x-icu`）时按拼音序**，
--    否则退化为库的默认排序（再加 `student_no, id` 兜底，保证**确定性**）。
--    **顺序只决定"谁排在前面"，不影响迁移正确性**（映射靠 `legacy_student_no` 一对一）。
-- ⚠️ 生成的同时写 `legacy_student_no = student_no` —— **只给这一次补号的老学生**写；
--    建档时就发号的新学生这一列恒为空串（"不是从老键迁过来的"）。
create or replace function public.assign_student_serials()
returns table (assigned int, unresolved int)
language plpgsql
as $$
declare
  v_coll text := '';
  v_assigned int := 0;
begin
  -- 拼音序优先（ICU）；库里没有这个 collation 就退化为默认排序（**不是失败**）
  begin
    perform 'x'::text collate "zh-x-icu";
    v_coll := ' collate "zh-x-icu"';
  exception when others then
    v_coll := '';
  end;

  execute format($f$
    with base as (
      select s.id, s.student_no, s.name, public.serial_year_of_class(s.class_id) as y
        from students s
       where s.serial = ''
         and s.legacy_student_no = ''      -- 老键存档已经有值的行 = 别动（异常态，交给自检清单）
    ), ranked as (
      select id, y, row_number() over (partition by y order by name%s, student_no, id) as rn
        from base where y <> ''
    ), used as (
      select left(s.serial, 4) as y, max(substr(s.serial, 5)::int) as mx
        from students s
       where s.serial ~ '^[0-9]{4}[0-9]{3}$'
       group by 1
    )
    update students t
       set serial = r.y || lpad((coalesce(u.mx, 0) + r.rn)::text, 3, '0'),
           legacy_student_no = t.student_no
      from ranked r
      left join used u on u.y = r.y
     where t.id = r.id
       and coalesce(u.mx, 0) + r.rn <= 999
  $f$, v_coll);
  get diagnostics v_assigned = row_count;

  /*
   * ⚠️ 发完号要**把计数器跟上**（否则下一个新建学生会拿到一个已经被用掉的号）。
   *    这一句是幂等的：`greatest` 只往上抬，从不往下拉。
   */
  insert into student_serial_counters (year, last_n)
  select left(s.serial, 4), max((substr(s.serial, 5))::int)
    from students s
   where s.serial ~ '^[0-9]{4}[0-9]{3}$'
   group by 1
  on conflict (year) do update
     set last_n = greatest(student_serial_counters.last_n, excluded.last_n);

  return query
    select v_assigned,
           (select count(*)::int from students s where s.serial = '');
end;
$$;

-- -------- 20.6 键值迁移（幂等）--------
-- 12 个字段一次跑完，逐个报"受影响行数"（验收第 10 条就是看第二次跑全为 0）。
-- 作用域：10 个字段用**档案所属的那个班**；`exams.absent_nos` 用 `exams.class_ids`（可能多班）；
--        `exam_scores.student_no` 用 `exam_scores.class_id`。
create or replace function public.migrate_nos_to_serial()
returns table (step text, rows_affected bigint)
language plpgsql
as $$
declare
  n bigint;
begin
  -- ---- ① assignments 的 6 个 text[] ----
  update assignments a set
    missing_nos    = (select coalesce(array_agg(public.serial_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.missing_nos) with ordinality as t(k, ord)),
    late_nos       = (select coalesce(array_agg(public.serial_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.late_nos) with ordinality as t(k, ord)),
    confirmed_nos  = (select coalesce(array_agg(public.serial_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.confirmed_nos) with ordinality as t(k, ord)),
    focus_nos      = (select coalesce(array_agg(public.serial_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.focus_nos) with ordinality as t(k, ord)),
    correction_nos = (select coalesce(array_agg(public.serial_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.correction_nos) with ordinality as t(k, ord)),
    corrected_nos  = (select coalesce(array_agg(public.serial_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.corrected_nos) with ordinality as t(k, ord))
   where exists (
     select 1 from unnest(a.missing_nos || a.late_nos || a.confirmed_nos
                       || a.focus_nos || a.correction_nos || a.corrected_nos) k
      where public.serial_key_pending(a.class_id, k)
   );
  get diagnostics n = row_count;
  step := 'assignments.text[]（6 个）'; rows_affected := n; return next;

  -- ---- ② assignments.wrong（jsonb：键 → 错题键数组）----
  update assignments a set
    wrong = (select coalesce(jsonb_object_agg(public.serial_key_of(a.class_id, k), v), '{}'::jsonb)
               from jsonb_each(a.wrong) as t(k, v))
   where exists (select 1 from jsonb_object_keys(a.wrong) k
                  where public.serial_key_pending(a.class_id, k));
  get diagnostics n = row_count;
  step := 'assignments.wrong'; rows_affected := n; return next;

  -- ---- ③ assignments.grades（jsonb：键 → 优/良/差）----
  update assignments a set
    grades = (select coalesce(jsonb_object_agg(public.serial_key_of(a.class_id, k), v), '{}'::jsonb)
                from jsonb_each(a.grades) as t(k, v))
   where exists (select 1 from jsonb_object_keys(a.grades) k
                  where public.serial_key_pending(a.class_id, k));
  get diagnostics n = row_count;
  step := 'assignments.grades'; rows_affected := n; return next;

  -- ---- ④ calls.student_nos（text[]）----
  update calls c set
    student_nos = (select coalesce(array_agg(public.serial_key_of(c.class_id, k) order by ord), '{}'::text[])
                     from unnest(c.student_nos) with ordinality as t(k, ord))
   where exists (select 1 from unnest(c.student_nos) k
                  where public.serial_key_pending(c.class_id, k));
  get diagnostics n = row_count;
  step := 'calls.student_nos'; rows_affected := n; return next;

  -- ---- ⑤ calls.states（jsonb：键 → called/arrived/corrected）----
  update calls c set
    states = (select coalesce(jsonb_object_agg(public.serial_key_of(c.class_id, k), v), '{}'::jsonb)
                from jsonb_each(c.states) as t(k, v))
   where exists (select 1 from jsonb_object_keys(c.states) k
                  where public.serial_key_pending(c.class_id, k));
  get diagnostics n = row_count;
  step := 'calls.states'; rows_affected := n; return next;

  -- ---- ⑥ exams.absent_nos（text[]；作用域 = 这次考试的**班级集合**）----
  update exams e set
    absent_nos = (select coalesce(array_agg(public.serial_key_of_classes(e.class_ids, k) order by ord), '{}'::text[])
                    from unnest(e.absent_nos) with ordinality as t(k, ord))
   where exists (select 1 from unnest(e.absent_nos) k
                  where public.serial_key_pending_classes(e.class_ids, k));
  get diagnostics n = row_count;
  step := 'exams.absent_nos'; rows_affected := n; return next;

  -- ---- ⑦ exam_scores.student_no（**值**迁移；列类型与 `unique (exam_id, student_no)` 都不动）----
  update exam_scores es set
    student_no = public.serial_key_of(es.class_id, es.student_no)
   where public.serial_key_pending(es.class_id, es.student_no);
  get diagnostics n = row_count;
  step := 'exam_scores.student_no'; rows_affected := n; return next;
end;
$$;

-- -------- 20.7 自检（验收口径的**唯一一处实现**：跑它就能看到所有该为 0 的数）--------
-- 前两组是"硬指标"（必须为 0）；第三组是"查不到的键"——**留原键 + 必须有一份写明原因的清单**（I14）。
-- ⚠️ **12 个字段无论有没有数据都会各出一行**（用 `left join` 兜零）：
--    否则"全 0"这件事在输出里根本看不见 —— 看不见的绿灯等于没有绿灯（§18.6 的教训）。
create or replace function public.serial_migration_report()
returns table (kind text, item text, n bigint)
language sql
stable
as $$
  with items(item) as (
    values ('assignments.missing_nos'), ('assignments.late_nos'), ('assignments.confirmed_nos'),
           ('assignments.focus_nos'), ('assignments.correction_nos'), ('assignments.corrected_nos'),
           ('assignments.wrong'), ('assignments.grades'),
           ('calls.student_nos'), ('calls.states'),
           ('exams.absent_nos'), ('exam_scores.student_no')
  ), stu as (
    select count(*) filter (where serial = '')::bigint            as no_serial,
           (count(*) - count(distinct nullif(serial, '')))::bigint as dup_serial
      from students
  ), keys as (
    select 'assignments.missing_nos'::text as item, array[a.class_id] as cids, k
      from assignments a, unnest(a.missing_nos) k
    union all select 'assignments.late_nos',       array[a.class_id], k from assignments a, unnest(a.late_nos) k
    union all select 'assignments.confirmed_nos',  array[a.class_id], k from assignments a, unnest(a.confirmed_nos) k
    union all select 'assignments.focus_nos',      array[a.class_id], k from assignments a, unnest(a.focus_nos) k
    union all select 'assignments.correction_nos', array[a.class_id], k from assignments a, unnest(a.correction_nos) k
    union all select 'assignments.corrected_nos',  array[a.class_id], k from assignments a, unnest(a.corrected_nos) k
    union all select 'assignments.wrong',          array[a.class_id], k from assignments a, jsonb_object_keys(a.wrong) k
    union all select 'assignments.grades',         array[a.class_id], k from assignments a, jsonb_object_keys(a.grades) k
    union all select 'calls.student_nos',     array[c.class_id], k from calls c, unnest(c.student_nos) k
    union all select 'calls.states',          array[c.class_id], k from calls c, jsonb_object_keys(c.states) k
    -- ⚠️ 考试这一处的作用域是**班级集合**（年级考试一次覆盖多个班）
    union all select 'exams.absent_nos',      e.class_ids, k from exams e, unnest(e.absent_nos) k
    union all select 'exam_scores.student_no', array[es.class_id], es.student_no from exam_scores es
  ), stat as (
    select item,
           count(*) filter (where public.serial_key_pending_classes(cids, k))::bigint as pending,
           count(*) filter (where k <> ''
                              and public.serial_key_state_classes(cids, k) = 'unknown')::bigint as unknown
      from keys group by item
  )
  select '硬指标'::text, 'students 没有序列号'::text, (select no_serial from stu)
  union all select '硬指标', 'students 序列号重复', (select dup_serial from stu)
  union all select '待迁键（必须为 0）', i.item, coalesce(s.pending, 0)
    from items i left join stat s on s.item = i.item
  union all select '查不到的键（留原键 + 出清单）', i.item, coalesce(s.unknown, 0)
    from items i left join stat s on s.item = i.item
  order by 1 desc, 2
$$;

-- -------- 20.8 回退（**与正向脚本一起写、一起测**，§4.4 的纪律）--------
-- 回退把键从序列号写回"迁移那一刻的班内学号"（`legacy_student_no`）。
-- ⚠️ 它**只对"从老键迁过来的"学生有效**（`legacy_student_no <> ''`）；
--    建档时就发号的新学生（legacy 为空）**没有老键可回** → 那些键留原样（进清单）。
create or replace function public.legacy_key_state_classes(p_class_ids uuid[], p_key text)
returns text
language sql
stable
as $$
  select case
    when p_key is null or p_key = '' then 'empty'
    when exists (
      select 1 from students s
       where s.class_id = any (coalesce(p_class_ids, '{}'::uuid[]))
         and s.legacy_student_no <> '' and s.legacy_student_no = p_key
    ) then 'legacy'
    when exists (
      select 1 from students s
       where s.class_id = any (coalesce(p_class_ids, '{}'::uuid[]))
         and s.legacy_student_no <> '' and s.serial = p_key
    ) then 'serial'
    else 'unknown'
  end
$$;

create or replace function public.legacy_key_of_classes(p_class_ids uuid[], p_key text)
returns text
language sql
stable
as $$
  select case public.legacy_key_state_classes(p_class_ids, p_key)
    when 'serial' then (
      select s.legacy_student_no from students s
       where s.class_id = any (coalesce(p_class_ids, '{}'::uuid[]))
         and s.serial = p_key and s.legacy_student_no <> ''
       order by s.legacy_student_no limit 1
    )
    else p_key
  end
$$;

create or replace function public.legacy_key_of(p_class_id uuid, p_key text)
returns text
language sql
stable
as $$ select public.legacy_key_of_classes(array[p_class_id], p_key) $$;

create or replace function public.revert_nos_to_legacy()
returns table (step text, rows_affected bigint)
language plpgsql
as $$
declare
  n bigint;
begin
  update assignments a set
    missing_nos    = (select coalesce(array_agg(public.legacy_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.missing_nos) with ordinality as t(k, ord)),
    late_nos       = (select coalesce(array_agg(public.legacy_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.late_nos) with ordinality as t(k, ord)),
    confirmed_nos  = (select coalesce(array_agg(public.legacy_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.confirmed_nos) with ordinality as t(k, ord)),
    focus_nos      = (select coalesce(array_agg(public.legacy_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.focus_nos) with ordinality as t(k, ord)),
    correction_nos = (select coalesce(array_agg(public.legacy_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.correction_nos) with ordinality as t(k, ord)),
    corrected_nos  = (select coalesce(array_agg(public.legacy_key_of(a.class_id, k) order by ord), '{}'::text[])
                        from unnest(a.corrected_nos) with ordinality as t(k, ord))
   where exists (
     select 1 from unnest(a.missing_nos || a.late_nos || a.confirmed_nos
                       || a.focus_nos || a.correction_nos || a.corrected_nos) k
      where public.legacy_key_state_classes(array[a.class_id], k) = 'serial'
   );
  get diagnostics n = row_count;
  step := 'assignments.text[]（6 个）'; rows_affected := n; return next;

  update assignments a set
    wrong = (select coalesce(jsonb_object_agg(public.legacy_key_of(a.class_id, k), v), '{}'::jsonb)
               from jsonb_each(a.wrong) as t(k, v))
   where exists (select 1 from jsonb_object_keys(a.wrong) k
                  where public.legacy_key_state_classes(array[a.class_id], k) = 'serial');
  get diagnostics n = row_count;
  step := 'assignments.wrong'; rows_affected := n; return next;

  update assignments a set
    grades = (select coalesce(jsonb_object_agg(public.legacy_key_of(a.class_id, k), v), '{}'::jsonb)
                from jsonb_each(a.grades) as t(k, v))
   where exists (select 1 from jsonb_object_keys(a.grades) k
                  where public.legacy_key_state_classes(array[a.class_id], k) = 'serial');
  get diagnostics n = row_count;
  step := 'assignments.grades'; rows_affected := n; return next;

  update calls c set
    student_nos = (select coalesce(array_agg(public.legacy_key_of(c.class_id, k) order by ord), '{}'::text[])
                     from unnest(c.student_nos) with ordinality as t(k, ord))
   where exists (select 1 from unnest(c.student_nos) k
                  where public.legacy_key_state_classes(array[c.class_id], k) = 'serial');
  get diagnostics n = row_count;
  step := 'calls.student_nos'; rows_affected := n; return next;

  update calls c set
    states = (select coalesce(jsonb_object_agg(public.legacy_key_of(c.class_id, k), v), '{}'::jsonb)
                from jsonb_each(c.states) as t(k, v))
   where exists (select 1 from jsonb_object_keys(c.states) k
                  where public.legacy_key_state_classes(array[c.class_id], k) = 'serial');
  get diagnostics n = row_count;
  step := 'calls.states'; rows_affected := n; return next;

  update exams e set
    absent_nos = (select coalesce(array_agg(public.legacy_key_of_classes(e.class_ids, k) order by ord), '{}'::text[])
                    from unnest(e.absent_nos) with ordinality as t(k, ord))
   where exists (select 1 from unnest(e.absent_nos) k
                  where public.legacy_key_state_classes(e.class_ids, k) = 'serial');
  get diagnostics n = row_count;
  step := 'exams.absent_nos'; rows_affected := n; return next;

  update exam_scores es set
    student_no = public.legacy_key_of(es.class_id, es.student_no)
   where public.legacy_key_state_classes(array[es.class_id], es.student_no) = 'serial';
  get diagnostics n = row_count;
  step := 'exam_scores.student_no'; rows_affected := n; return next;
end;
$$;

-- 🔴 三个**会改数据**的函数一律 revoke：它们是迁移工具，不是给前端调的接口
--    （前端能调到 = 有人能把键写回老学号，而且不报错）。
revoke all on function public.assign_student_serials()   from public, anon, authenticated;
revoke all on function public.migrate_nos_to_serial()    from public, anon, authenticated;
revoke all on function public.revert_nos_to_legacy()     from public, anon, authenticated;

-- -------- 20.9 跑一遍（**幂等**：这一段就是"迁移脚本"，重复执行第二遍 0 行）--------
--  ⚠️ 入校年份先要有着落。Q18 已经给了三个年级的届（**用户给的值，不是猜的**）：
--     高二 = 2025、高一 = 2026、高三 = 2024。
--     这一段只填**空的**（`where coalesce(year,'') = ''`）→ 已有值一个都不覆盖。
--     ⚠️ P3 会把"届"正式落到 `grades.cohort`（那时 §20.3 会**优先**读 cohort）；
--        这里填的是**老列** `grades.year`（它的注释本来就写着"2026 级"）。
--     ⚠️ 它只碰 `year` 这一列，**绝不碰 `name` / `stage`**（`grades` 的字段是权限判据的一环，I30）。
update grades set year = '2025' where name = '高二' and coalesce(year, '') = '';
update grades set year = '2026' where name = '高一' and coalesce(year, '') = '';
update grades set year = '2024' where name = '高三' and coalesce(year, '') = '';

do $$
declare
  v_assigned int;
  v_unresolved int;
  r record;
  v_pending bigint := 0;
begin
  select assigned, unresolved into v_assigned, v_unresolved from public.assign_student_serials();
  raise notice '[§20] 序列号生成：本次发出 % 个；仍然没有序列号 % 个（认不出入校年份的会在下面报出来）',
    v_assigned, v_unresolved;

  for r in select * from public.migrate_nos_to_serial() loop
    raise notice '[§20] 键迁移 %：受影响 % 行', r.step, r.rows_affected;
    v_pending := v_pending + r.rows_affected;
  end loop;

  raise notice '[§20] 本轮键迁移合计受影响 % 行（**再跑一遍这一节应当是 0 行**）', v_pending;
end $$;

-- -------- 20.10 迁移前的整份导出存档（**可回滚的根据**，§4.4）--------
--  跑 20.9 之前**必须**先跑这两条并把结果存到迁移脚本之外的地方
--  （Supabase SQL Editor 里 `select jsonb_agg(...)` 的结果可以直接下载成 JSON）。
--  这里以注释形式留档，**不在 schema.sql 里自动执行**（自动执行 = 每次都导一份没人看的档）。
--
--  select jsonb_agg(jsonb_build_object(
--    'id', id, 'class_id', class_id,
--    'wrong', wrong, 'missing_nos', missing_nos, 'late_nos', late_nos,
--    'confirmed_nos', confirmed_nos, 'focus_nos', focus_nos,
--    'correction_nos', correction_nos, 'corrected_nos', corrected_nos,
--    'grades', grades)) from assignments;
--
--  select jsonb_agg(jsonb_build_object(
--    'id', id, 'class_id', class_id,
--    'student_nos', student_nos, 'states', states)) from calls;
--
--  select jsonb_agg(jsonb_build_object(
--    'id', id, 'class_ids', class_ids, 'absent_nos', absent_nos)) from exams;
--
--  select jsonb_agg(jsonb_build_object(
--    'id', id, 'exam_id', exam_id, 'class_id', class_id, 'student_no', student_no)) from exam_scores;
--
--  ⚠️ 回退 SQL 是 **20.8 的 `revert_nos_to_legacy()`**（与正向脚本同一套判据，也幂等）：
--     `select * from public.revert_nos_to_legacy();`
--     注意它与上面那份"整份 JSON 存档"是**两套**回退手段，别只留一套：
--     存档能回到"迁移前的字节"，`revert` 只能回到"迁移前的键"。
-- ============================================================

-- ============================================================
--  21. 通知（2026-09-28 新增）—— 「学校对老师说话」
--      设计见 `管理架构与角色权限方案.md` §九 · 不变量见 `功能设计与不变量.md` I45–I50
--
--  🔴 读这一节之前先记住一句话：**呼叫 ≠ 通知**（方案 §0.1）。
--     · **呼叫**（`calls`）：老师对**学生**说话，去**教室那块大屏**，`student_nos` / `class_id` /
--       `assignment_id` 三样俱全，有播报状态。
--     · **通知**（本节）：**学校对老师**说话，落在**教师的平台界面**上，**一个学生都没有**。
--     → `notices` 里**不许出现** `student_nos` / `class_id` / `assignment_id`（I45），
--       `calls` 的读策略**一个字都不改**（通知不许搭它的车）。
--       合并的那一刻就会出现：「全体教师周三开会」被教室里那块屏播报出去。
--
--  🔴 三条纪律（每一处实现都受它们约束）：
--     ① **教室端一条都读不到**（I47）。它不是"界面上不渲染"，是**拿不到** ——
--        读策略里**根本没有教室端的分支**（与 §10.5 那条"教室端靠 can_view_all_subjects 的
--        一支读作业"是反过来的同一个坑：**多给一支**，那块学生碰得到的屏上就会出现
--        不该出现的东西）。
--     ② **"能发给全校"与"能发给本年级"是两种权限**（I46）。判据**只在数据库/服务端**
--        （`can_publish_notice_to`），前端藏掉"全校"那个选项**不是**安全边界。
--     ③ **收件人用"范围"存、不用"名单"存**（I50）：`notice_targets` 一行一个范围值，
--        收件人是**算出来的**（"能推出来的状态不许再存一份"）。
--        → 语义是**当下**：老师换了年级就看不到旧通知。
--        ⚠️ 若将来要改成"发出时冻结"，改的是**写入端**（发的时候把收件人算出来写进
--           `notice_targets` 的 kind='teacher' 行），**表结构不用改**。
--
--  🆕 2026-09-28 第二轮（**部门维度**）：收件维度从**六种**变成**七种**
--     （`school` / `grade` / `subject` / `grade_subject` / `role` / `custom`
--      / 🆕 **`department`**），并把 `admin`（教务处主任）加回"按职位发"的清单。
--     落点：§21.2.2（老师 ↔ 部门的归属表 + 判据）· §21.3.1（两条 check 换版）·
--     §21.4（能发部门）· §21.5（收件人那一支）。
--
--  本段可重复执行（幂等）。它**不动任何现有策略**；对既有对象的动作只有三处，都列在这里：
--    · `teachers.notice_seen_at` 那一列在 §1（纯新增）；
--    · §21.3.1 把 `notices.scope_kind` / `notice_targets.target_kind` 两条 check
--      **换版**（六值 → 七值，多一个 `'department'`）。🔴 这属于**破坏性迁移**
--      （约束收紧/放宽都改的是既有对象），所以那一段用"**先建新的、再删旧的**"写法
--      （任何一刻都有约束在），**回退 SQL 就写在它后面（§21.3.2）**；
--    · §21.2.2 新建 `teacher_departments`（老师 ↔ 职能部门，**多对多且可空**）。
-- ============================================================

-- -------- 21.1 权限层级（**唯一的一处**）--------
--  「一档身份比另一档高吗」这件事在平台里今天只有一个用途：**发通知时不许越级**
--  （见 §21.4 的 `can_publish_notice_to`）。它**不是**"谁能看什么"的判据 ——
--  数据可见性全在 `visible_class_ids()` 那一套里，别把这张表拿去写别的 if。
--
--  档位（大 → 小）：
--    100 super · 90 admin · 80 校级三档 · 70 办公室主任 / 德育处主任
--     60 年级主任 · 50 教研组长 · 40 备课组长 · 10 班主任 · 1 任课教师
--      0 没有任何 teacher_roles 行（新老师；教室端**没有角色行，所以也是 0** —— 见下）
--
--  🔴 教室端必须**显式**挡掉，不能靠"它也是 0 档"：`teacher_rank` 对教室端返回 0，
--     而 0 < 60（年级主任），于是"年级主任把通知发给教室端"会被判成合法 ——
--     `can_publish_notice_to` 里那三个 `not exists (... classroom_accounts ...)`
--     就是为这一件事写的。**三个分支各写一次，不能只写一处。**
create or replace function public.teacher_rank(p_uid uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  -- `.role` 是关键字，所以每一处都写成 `r.role`
  select coalesce(max(case r.role
    when 'super'              then 100
    when 'admin'              then  90
    when 'principal'          then  80
    when 'vice_principal'     then  80
    when 'principal_assistant' then 80
    when 'office_head'        then  70
    when 'moral_edu_head'     then  70
    when 'grade_head'         then  60
    when 'subject_lead'       then  50
    when 'lesson_prep_lead'   then  40
    when 'head_teacher'       then  10
    when 'teacher'            then   1
    else 0
  end), 0)
  from teacher_roles r
  where r.teacher_id = p_uid;
$$;

revoke all on function teacher_rank(uuid) from public, anon, authenticated;

-- -------- 21.2 发给"职位"：允许的职位清单（**唯一的一处**）--------
--  用户点名的四种收件维度之一：「**哪个职位**」。
--  🔴 一条**我替用户定的保守默认**（报告里标为假设）：
--     **"发给职位"只允许发给自己级别以下的档位** ——
--     年级主任能发给本年级的班主任 / 老师 / 备课组长，**不能**发给校长 / 教务处 / 超管
--     （后三者：前两档**不在清单里**，超管是"级别比他高"）。
--     理由：不这么定，任何人都能给超管发通知（通知是"学校对老师说话"，
--     而"我给校长发了条通知"这句话在语义上就不成立）。
--
--  ⚠️ 清单里仍然**没有校级三档（80）** —— 这是**刻意**的，这一轮一个字都没动：
--     它撑着一条口径：**"下级通知上级"这件事平台不承载** —— 要给校长递话走
--     「**全校**」那一档（`school` 按 `teachers` 行算，校长也在其中；或者走现实里的路）。
--
--  🆕 2026-09-28 第二轮：**把 `admin`（90：教务处主任）加回来**（用户拍板
--     「把教务处主任加回『按职位发』的清单」）。清单因此是 **八档**。
--  🔴 **加 `admin` 会不会破坏上面那条口径？不会**（这是本轮的判断，写下来免得被当成漏改）：
--     · "能发到某一档" = `notice_role_is_sendable(档)`（在清单里）**且**
--       `me.rank > notice_role_min_rank(档)`（见 §21.4 的 `role` 支）。
--     · `notice_role_min_rank` 取的是这一档手上**最高**那一档级别（`teacher_rank` 是 `max`），
--       所以拿 `admin` 的人 rank 恒 ≥ 90 → **只有超管（100）发得到它**；
--       教务处主任自己（90 > 90 = false）、校长（80）、年级主任（60）都发不到。
--     · 也就是说 `admin` 进清单**不会**新增任何"下级 → 上级"的路径，
--       它只是让**超管**多一个"直接发给教务处主任"的落点（原来只能走「全校」）。
--     · 校级三档**依旧只有「全校」一条路**（对超管也一样），那条口径原样成立。
--  ⚠️ "超管拥有一切权限"在这一档上体现为**清单里那八档他一档都不缺**，
--     不是"清单外面还有几档"（`rls-checks` 有一条断言钉着它）。
--  🔴 **这一组值在三个地方必须是同一组**（少一处就是"同一件事两个口径"）：
--     本函数 = 服务端 `app/functions/api/notice.ts` 的 `SENDABLE_ROLES`（形状校验，不在里面直接 400）
--     = 界面拿到的选项（`my_notice_scopes()` 只把本函数的行列出来）。
--     ⚠️ **上一轮就是栽在这里**：清单从七档变八档时，只改数据库不改服务端 =
--        数据库说 true、真实调用仍然 400 —— 因为**形状校验在 RPC 之前**，它先说"不认识"。
--        所以 `nav-checks` 的 **A9** 现在拿**源码文本**逐字比对这两份清单（外加部门那三份）。
create or replace function public.notice_sendable_roles()
returns setof text
language sql
immutable
as $$
  select unnest(array[
    'admin',              -- 90：教务处主任（🆕 本轮加回来的）
    'office_head',        -- 70：办公室主任
    'moral_edu_head',     -- 70：德育处主任
    'grade_head',         -- 60：年级主任
    'subject_lead',       -- 50：教研组长
    'lesson_prep_lead',   -- 40：备课组长
    'head_teacher',       -- 10：班主任
    'teacher'             --  1：任课教师
  ]::text[]);
$$;

grant execute on function notice_sendable_roles() to authenticated;

-- -------- 21.3 建表 --------
--  两个新表都开 RLS、对 anon 一律 revoke（与 §10.1 的新表同一套）。
--
--  ⚠️ 写入**只走服务端** `POST /api/notice`（service_role，绕过 RLS）——
--     所以这两张表**没有一条 insert/update/delete 策略**。
--     这不是"忘了写"：多一条写策略就多一个前端能绕过的口子，
--     而"谁能发/能发给谁"的判断必须在服务端问数据库（§21.4）。
create table if not exists notices (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid references schools (id) on delete set null,
  -- 🔴 发件人由**服务端从调用者 JWT 取**，前端传什么都不信（与 calls.teacher_id 同一条纪律）
  sender_id         uuid not null references teachers (id) on delete cascade,
  title             text not null default '',
  -- 纯文本。**不做富文本**：富文本 = XSS 面 + 排版调试，与"不增加录入"的反指标冲突
  body              text not null default '',
  -- 发布范围：与 notice_targets.target_kind 一一对应
  -- ⚠️ 下面这一串**六值**是**历史原文**（建表那一刻的样子）。🆕 §21.3.1 会把它换成
  --    **七值**（多一个 `'department'`）—— 那一段是"先建新的、再删旧的"，
  --    所以**不要在这里改**（改了会让"老库重跑"与"新库首跑"两条路的约束名字不一致）。
  scope_kind        text not null default 'school'
                    check (scope_kind in ('school','grade','subject','grade_subject','role','custom')),
  -- 有效期（为空 = 不过期）：过期后**从默认列表里消失，但不删**（历史仍可查）
  expires_at        timestamptz,
  -- 置顶：只有教务处与超管能置顶（置顶别人的通知 = 改别人话的权重）
  pinned            boolean not null default false,
  -- 撤下时刻（为空 = 有效）。⚠️ **撤下不删行** —— 删了就没法回答"这条通知曾经存在过吗"
  revoked_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists notices_created_idx on notices (created_at desc);
create index if not exists notices_sender_idx  on notices (sender_id, created_at desc);

-- 🔴 `notice_targets` 里**没有** `target_id` 那一个"三种语义"的列（方案 §九.4 点名的忌讳）：
--    一行一个**维度值**，按 `target_kind` 只有一列非空 —— 一个字段只有一种语义。
--  🆕 2026-09-28 第二轮加部门这一维时，**同样是新增一列 `target_department`，
--     不是复用 `target_role`** —— 理由就写在那一列旁边（见下）。
create table if not exists notice_targets (
  notice_id    uuid not null references notices (id) on delete cascade,
  -- ⚠️ 六值清单同样是**历史原文**，§21.3.1 换成七值（多 `'department'`）。别在这里改。
  target_kind  text not null
               check (target_kind in ('school','grade','subject','grade_subject','role','teacher')),
  grade_id     uuid references grades (id) on delete cascade,  -- kind in ('grade','grade_subject')
  subject_code text references subjects (code) on delete cascade, -- kind in ('subject','grade_subject')
  target_role  text,                                            -- kind = 'role'
  teacher_id   uuid references teachers (id) on delete cascade,  -- kind = 'teacher'（自定义名单）
  created_at   timestamptz not null default now()
);
-- 🆕 `target_department`：kind = 'department'。
--  🔴 **为什么是新增一列，而不是复用 `target_role`**（本轮的取舍，写下来）：
--     · 复用 = 让**同一个字段有两种语义**（职位代码 / 部门代码），而"哪一种是哪一种"
--       要靠 `target_kind` 才能推出来 —— 正是上面那句"一个字段只能有一种语义"要挡的事，
--       也是 §九.4 点名 `target_id` 时说的同一个形状。
--     · 具体会坏在哪：一张部门通知的 `target_role` 里躺着 `'academic'`，
--       而"发给职位"那条判据读同一列 → `notice_role_has_members('academic')` = false
--       → 收件人算出来是空集（**通知发出去，谁都收不到，而且不报错**）。
--     · 代价：`notice_targets` 多一列（可空、默认为空，老行一个字都不用动）。
--       一列的代价 vs "一个字段两种语义"的代价，这里选前者。
--  ⚠️ 列用 `add column if not exists` 补（线上那张表已经存在，`create table if not exists`
--     不会改它）—— 与 §10.1.1 ③ 的 `teacher_roles.subject_code` 同一条路。
alter table notice_targets add column if not exists target_department text;
-- 幂等：同一条通知同一个维度值只写一次（**不写 unique 约束**是刻意的 ——
-- `coalesce` 占位那一套在这里反而更难读；服务端去重，脚本按"集合"断言）。
create index if not exists notice_targets_notice_idx on notice_targets (notice_id);
-- 收件人算得快的两条：`teacher_id`（自定义名单）与 `grade_id`（本年级）
create index if not exists notice_targets_teacher_idx on notice_targets (teacher_id);
create index if not exists notice_targets_grade_idx   on notice_targets (grade_id);
-- 「这条通知里有没有'我这一科'」是**每一次读**都要问的（读策略的第二个 or），给它一条索引
create index if not exists notice_targets_subject_idx on notice_targets (subject_code);
-- 🆕 部门那一支的索引（与上面 `subject_code` 那条同一个理由：每一次读都要问）
create index if not exists notice_targets_department_idx on notice_targets (target_department);

-- -------- 21.3.1 🆕 两条 check **换版**：六值 → 七值（`'department'`）--------
--  🔴 这属于**破坏性迁移**（改的是既有对象上的约束），所以写法要按 §10.1.1 那条顺序纪律来：
--     **先建新的（名字带 `_v2`）、再删旧的** —— 两者短暂并存，任何一刻都有约束在。
--     ⚠️ **不要**写成"先 `drop constraint`、再 `add constraint`"：那会留下一个
--     "表上没有这条约束"的窗口（这一段脚本恰好被中断在中间时，库就停在无约束状态）。
--     这里用 `do $$ … $$` + `pg_constraint` 判存在，是同一件事的**幂等**写法
--     （重跑第二次：`_v2` 已在 → 什么都不做；旧名早被删 → 也什么都不做）。
--
--  ⚠️ 旧约束的名字：建表时那条内联 check 由 Postgres 自动命名 = `<表>_<列>_check`。
--     所以老库上是 `notices_scope_kind_check` / `notice_targets_target_kind_check`。
do $$
begin
  -- ① `notices.scope_kind`（发布范围）：加 'department'
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'notices'::regclass and conname = 'notices_scope_kind_check_v2'
  ) then
    alter table notices add constraint notices_scope_kind_check_v2
      check (scope_kind in ('school','grade','subject','grade_subject','role','custom','department'));
  end if;
  if exists (
    select 1 from pg_constraint
     where conrelid = 'notices'::regclass and conname = 'notices_scope_kind_check'
  ) then
    alter table notices drop constraint notices_scope_kind_check;
  end if;

  -- ② `notice_targets.target_kind`（收件范围的形状）：加 'department'
  --    ⚠️ 它与 ① **不是同一组值**：① 有 `'custom'`（那是界面的"勾人"），
  --       ② 有 `'teacher'`（那是表里存的"一行一个人"）。两份清单在函数里就分开列。
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'notice_targets'::regclass and conname = 'notice_targets_target_kind_check_v2'
  ) then
    alter table notice_targets add constraint notice_targets_target_kind_check_v2
      check (target_kind in ('school','grade','subject','grade_subject','role','teacher','department'));
  end if;
  if exists (
    select 1 from pg_constraint
     where conrelid = 'notice_targets'::regclass and conname = 'notice_targets_target_kind_check'
  ) then
    alter table notice_targets drop constraint notice_targets_target_kind_check;
  end if;

  -- ③ 🆕 `target_department` 自己的 check（四值清单在 SQL 里的第二处，见 §21.2.2）
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'notice_targets'::regclass and conname = 'notice_targets_department_check'
  ) then
    alter table notice_targets add constraint notice_targets_department_check
      check (target_department is null
             or target_department in ('office','academic','logistics','moral_edu'));
  end if;
end $$;

-- -------- 21.3.2 🆕 回退 SQL（这一段出问题时跑，**手工**）--------
--  🔴 回退的第一步永远是"**先处理数据、再改约束**"（§10.1.3 同一条纪律）：
--     约束加不回去，只要表里还有那个新值的行。顺序反了会直接报错。
--
--  -- ① 先把部门维度的收件行删掉（**这一步不可逆，先导出一份**）
--  -- delete from notice_targets where target_kind = 'department';
--  -- update notices set scope_kind = 'school' where scope_kind = 'department';
--  -- ② 再把两条约束换回六值版（同样"先建后删"，幂等）
--  -- alter table notices drop constraint if exists notices_scope_kind_check_v2;
--  -- alter table notices add constraint notices_scope_kind_check
--  --   check (scope_kind in ('school','grade','subject','grade_subject','role','custom'));
--  -- alter table notice_targets drop constraint if exists notice_targets_target_kind_check_v2;
--  -- alter table notice_targets add constraint notice_targets_target_kind_check
--  --   check (target_kind in ('school','grade','subject','grade_subject','role','teacher'));
--  -- ③ 部门归属那一张表**可以留着**（`drop table teacher_departments` 是另一件事）：
--  --    留着不影响任何东西（没有它就没有部门收件人），而 drop 之后再想加回来要重走一遍迁移。
--  -- ④ `notice_sendable_roles()` 里那个 `'admin'` 要退回去就改函数体（§21.2）——
--  --    ⚠️ 但**三处必须一起退**（本函数 + `notice.ts` 的 `SENDABLE_ROLES` + `nav-checks` A9），
--  --    只退一处就是"数据库说 true、真实调用仍然 400"。

alter table notices        enable row level security;
alter table notice_targets enable row level security;

grant select on notices, notice_targets to authenticated;
revoke all on notices, notice_targets from anon;

--  「这个人算不算**任课教师**那一档」——🔴 2026-09-28 实测踩到的一处漏人：
--  `teacher_roles.role = 'teacher'` 是一个**历史值**，现实里**没有任何一行**用它 ——
--  任课教师的身份是 `class_subjects` 里的任课关系，**根本不写那张表**（§10.6）。
--  所以"发给任课教师"如果只按 `role = 'teacher'` 去查，**一个人都发不到**，
--  而那正是最常见的一档。
--  口径（与 §10.6 对"任课教师"的定义逐字一致）：
--    **没有任何 `teacher_roles` 行的在册教师（不含教室端）= 任课教师**。
--  ⚠️ 它只回答"这一档里有没有他"，**不回答"能不能给他发"** —— 后者还要比级别（§21.4）。
create or replace function public.notice_is_plain_teacher(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from teachers t where t.id = p_uid)
     and not exists (select 1 from classroom_accounts ca where ca.id = p_uid)
     and not exists (select 1 from teacher_roles r where r.teacher_id = p_uid);
$$;

revoke all on function notice_is_plain_teacher(uuid) from public, anon, authenticated;

--  ---- 21.2.1 「清单里有这一档吗」与「空职位」的两支小判据 ----
--  🔴 **为什么把它们单独立成函数**（本轮实测踩到的坑，值得写下来）：
--     `can_publish_notice_to_for` 是 `security definer`，但它**内部引用别的函数**时，
--     那些函数是不是 `security definer` 会决定"以谁的身份去调"。
--     `notice_sendable_roles()` 一开始写成了**普通函数**（`immutable`、没有 security definer），
--     于是它按**调用者**（登录教师）的身份去查 —— 而它与其余判据一样被 revoke 过，
--     结果 `x in (select * from notice_sendable_roles())` **一条都匹配不上**，
--     表现为"**连超管都发不了'某个职位'**"（而报错一行都没有）。
--     → 口径：**判据链上的每一个函数都必须是 `security definer`**，一个例外都不能留。
create or replace function public.notice_role_has_members(p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- 'teacher' 那一档的现实形状见 `notice_is_plain_teacher()`
    when p_role = 'teacher' then exists (
      select 1 from teachers t
       where not exists (select 1 from classroom_accounts ca where ca.id = t.id)
         and not exists (select 1 from teacher_roles r where r.teacher_id = t.id))
    else exists (select 1 from teacher_roles r where r.role = p_role)
  end;
$$;

revoke all on function notice_role_has_members(text) from public, anon, authenticated;

--  「这个职位上**最低**那一档的级别」——`can_publish_notice_to` 的"不许越级"用它。
--  ⚠️ 空职位返回 **null**（不是 0）：0 会让 `me.rank > 0` 对**任何人**成立，
--     于是"发给一个根本不存在的职位"变成永远放行 —— 那是一条真实的漏洞（本轮实测踩到）。
--  ⚠️ 它**必须与判据链上的每一个函数一样**是 `security definer`（理由见 21.2.1 那段）。
create or replace function public.notice_role_min_rank(p_role text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_role = 'teacher' then 1   -- §21.1 的档位表：任课教师 = 1
    else (select min(public.teacher_rank(r.teacher_id))
            from teacher_roles r where r.role = p_role)
  end;
$$;

revoke all on function notice_role_min_rank(text) from public, anon, authenticated;

--  「清单里有这一档吗」——专门给 `can_publish_notice_to_for` 用的**判据内判据**。
--  🔴 为什么不能直接在函数体里写 `x in (select * from notice_sendable_roles())`：
--     写法上没问题，但 `security definer` 的函数体**引用另一个函数**时，
--     那个函数是不是 `security definer` 决定"以谁的身份去调它"——
--     本轮实测：普通（invoker）版本会按**登录教师**的身份去查，被 revoke 之后
--     **一条都匹配不上**，症状是"**连超管都发不了'某个职位'**"。
--     → 所有判据链上的函数一律 `security definer`，这一支也不例外。
create or replace function public.notice_role_is_sendable(p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_role, '') in (select * from notice_sendable_roles());
$$;

revoke all on function notice_role_is_sendable(text) from public, anon, authenticated;

--  「这个人按**他的职位**算，最低能压到哪一档」——勾人（custom）那一支用它。
--  ⚠️ 取 **min**（不是 max）是刻意的：一个人可以同时是"教务处 + 任课教师"，
--     而"能不能给他发"应当按**他最低那一档**判 —— 否则一档高身份就把整条限制抵掉了。
create or replace function public.notice_min_rank_of(p_uid uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(min(public.teacher_rank(r.teacher_id)), 0)
    from teacher_roles r where r.teacher_id = p_uid;
$$;

revoke all on function notice_min_rank_of(uuid) from public, anon, authenticated;

-- -------- 21.2.2 🆕 部门归属（老师 ↔ 职能部门）—— 表 + 清单 + 判据（2026-09-28 第二轮）--------
--  用户原话：「通知这里，应该还可以给各个职能部门发通知呀」。
--  学校的**真实架构**是四个职能部门：**办公室 · 教务处 · 总务处 · 德育处**。
--
--  🔴 三条形状上的硬要求（都是用户的真实情况，不是设计偏好）：
--     ① **一个人可能兼任多个部门**（教务处 + 德育处 是常见的），
--     ② **一个人可能不属于任何部门**（纯任课老师）—— 所以关系**多对多且可空**，
--     ③ 判据形状要跟现有角色体系一致（"谁在哪个范围里"这件事，
--        `teacher_roles` 那套 `role + scope_type + scope_id` 是现成的先例）。
--
--  🔑 **为什么另起一张表，而不是 `teachers` 上加一列 `departments text[]`**
--     （数组列改起来简单、但是这次**不能**用它，理由是一条真实的可写路径）：
--     · `teachers` 上那条 `teachers_self` 是 **`for all` = `id = auth.uid()`**（§7）——
--       也就是说**任何一位老师都能 UPDATE 自己那一行**。部门归属一旦落在 `teachers` 上，
--       就等于"老师可以自己把自己填进『教务处』"，而那正好是通知的收件范围：
--       他会**读到自己不该读的通知**（一条真实的越权读取路径，不是理论）。
--     · 另起一张表可以像 `teacher_roles` 一样**只给 select、一条写策略都不给** ——
--       写只走服务端 `functions/api/teacher-account.ts`（service_role），判据在那里问数据库。
--     · 顺带：数组列在"查一个部门有谁"这件事上要 `@>` 扫描，没有索引可用；
--       这张表上有 `(department)` 索引，收件人那一支是一次索引扫描。
--     · ⚠️ 代价说清楚：多一张表 = 多一套 RLS（下面四条语句），
--       而且"一个人挂在哪个部门"这个事实从此**只在这张表里**（不是第二处）。
--
--  🔴 **它不进 `teacher_roles`**（这是本轮另一个判断）：`teacher_roles` 那一列存的是
--     **身份**（有权限的那一档：`admin` = 教务处**主任**），而"属于教务处"是**档案属性** ——
--     教务处的干事也"属于教务处"，但他**不该**因此拿到 `admin` 的全部权限。
--     把两者合成一个字段，就是"一个字段两种语义"（§九.4 点名的那个忌讳）。
--
--  🔴 **表放在这里而不是 §21.3（建表那一段）**：下面 `notice_department_has_members()`
--     的函数体在**创建那一刻**就会被解析，表必须先在 ——
--     本仓库踩过同一个坑两次：`create policy` 与 `language sql` 的函数体引用尚未定义的
--     东西（函数 / 表）都是**当场报错**，不是等到调用才报。
create table if not exists teacher_departments (
  teacher_id uuid not null references teachers (id) on delete cascade,
  -- 部门代码。⚠️ 这一行是**四值清单在 SQL 里的第二处**（第一处是下面的 `notice_departments()`）——
  --    列上留一条 check 是让"表自己守得住"（service_role 也塞不进垃圾），
  --    `rls-checks` 有一条断言把这两处**逐字比对**（少一处对不上就红）。
  department text not null
             constraint teacher_departments_department_check
             check (department in ('office','academic','logistics','moral_edu')),
  created_at timestamptz not null default now(),
  -- 主键 = "同一个人同一个部门只有一行"（幂等写入靠它，服务端重复写按 23505 当成功）
  primary key (teacher_id, department)
);
-- 「这个部门有谁」是收件人那一支每一次读都要问的 —— 给它一条索引（主键那条是 (teacher_id, …)）
create index if not exists teacher_departments_dept_idx on teacher_departments (department);

alter table teacher_departments enable row level security;
grant select on teacher_departments to authenticated;
revoke all on teacher_departments from anon;

-- 🔴 **只有一条 select 策略、没有任何写策略**（与 `teacher_roles_read` 逐字同款，§10.4）：
--    读 = 自己那一行（"我属于哪个部门"）；写 = **没有**，
--    只能走服务端 `POST /api/teacher-account` 的 `department` 动作（service_role）。
--    这一条是"读得宽、写得窄"在本表上的落点，也是上面那段"为什么不用数组列"的答案。
drop policy if exists teacher_departments_read on teacher_departments;
create policy teacher_departments_read on teacher_departments
  for select to authenticated using (teacher_id = auth.uid());

--  「有哪些部门」——**SQL 侧的唯一定义**。
--  ⚠️ 与 `notice_sendable_roles()` 同款：`immutable` + 不读任何表 + grant 给 authenticated
--     （它只是把四个常量列出来，所以不受"判据链上必须 security definer"那条的影响）。
--  🔴 这一组值在**三个地方**必须是同一组：
--     本函数 = 列上那条 check = 服务端 `notice.ts` 的 `DEPARTMENTS`
--     （界面显示名在 `app/src/lib/departments.ts`，`nav-checks` A9 把这几份逐字比对）。
create or replace function public.notice_departments()
returns setof text
language sql
immutable
as $$
  select unnest(array[
    'office',     -- 办公室
    'academic',   -- 教务处
    'logistics',  -- 总务处
    'moral_edu'   -- 德育处
  ]::text[]);
$$;

grant execute on function notice_departments() to authenticated;

--  「这个部门在清单里吗」——照 `notice_role_is_sendable()` 的写法（判据内判据）。
--  🔴 判据链上的函数一律 `security definer`（理由见 §21.2.1 那段实测）。
create or replace function public.notice_department_is_sendable(p_department text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_department, '') in (select * from notice_departments());
$$;

revoke all on function notice_department_is_sendable(text) from public, anon, authenticated;

--  「这个部门里真的有人吗」——照 `notice_role_has_members()` 的写法。
--  ⚠️ 空了必须**拒**（返回 false），不能靠 `coalesce(…, 0)` 兜 ——
--     "发给一个没有任何人的部门"与"发给一个不存在的职位"是同一个洞：
--     通知发出去，**谁都收不到**，而列表里多出一条谜。
create or replace function public.notice_department_has_members(p_department text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from teacher_departments td where td.department = p_department);
$$;

revoke all on function notice_department_has_members(text) from public, anon, authenticated;

--  「他能发到**校级单位**那一档吗」= 全校 + 🆕部门 **共用**的那一组人，**唯一的定义处**。
--  超管 · 教务处 · 校级三档 · 办公室主任 · 德育处主任（七档里除年级主任与两个组长之外的全部）。
--  🔴 为什么把部门与全校并成一组（本轮的判断，写下来）：
--     · 部门是**跨班级 / 跨年级的校级单位**（教务处管全校的教务），
--       所以"面向一个部门说话"是"面向全校说话"的一小部分，不是"面向本年级"那一种 ——
--       能发全校的人就能发部门，这一条不需要另算级别；
--     · 反过来：**年级主任 / 组长不许给部门发**。那正是 §21.2 那条口径的另一张脸 ——
--       教务处 / 办公室的人（级别比他高）就在这些部门里，"下级通知上级"平台不承载。
--     · ⚠️ 写在**一个函数**里而不是抄两遍：这一组值一改就是两处不一致（I17），
--       而 `school` 与 `department` 两支都调它。
create or replace function public.notice_can_publish_school_level(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from teacher_roles r
     where r.teacher_id = p_uid
       and r.role in ('super','admin','principal','vice_principal',
                      'principal_assistant','office_head','moral_edu_head')
  );
$$;

revoke all on function notice_can_publish_school_level(uuid) from public, anon, authenticated;

-- -------- 21.4 「我能给谁发」——**本能力的全部安全性都在它身上**（方案 §九.8 的 P-2）--------
--  🔴 三个 Check 的顺序就是这三句话：**有没有身份 → 这个范围对不对 → 名单里的人能不能收**。
--  ⚠️ 与 §13.3 同一套手法：security definer + `set search_path = public`，
--     且**函数必须由表属主创建**（否则内层读取会再触发策略 → 无限递归）。
--  两件套（I33）：`_for` 是函数体、显式传人、**一律 revoke**；裸版是薄包装。
--
--  🆕 2026-09-28 第二轮：参数多了**第七个** `p_department`（部门维度）。
--  🔴 **加参数 = 换了签名**（Postgres 的 `CREATE OR REPLACE` 认的是"名字 + 入参类型"）：
--     不加处理的写法会**多出一个六参重载**，旧的那个继续躺在库里 ——
--     那就是"同一件事两个入口"（旧入口把 `'department'` 判成 false，症状是
--     "数据库里七种维度，其中一种怎么发都 403，而一行报错都没有"）。
--     → 顺序：**先建新的七参版**（下面这一句），**再 drop 掉旧的六参版**（紧跟其后），
--       最后 revoke 新的那份。这与 §10.1.1 那条"先建新的、后删旧的"是同一条纪律：
--       任何一刻，库里都有一个能用的版本。
create or replace function public.can_publish_notice_to_for(
  p_uid uuid,
  p_scope_kind text,
  p_grade_id uuid,
  p_subject_code text,
  p_target_role text,
  p_teacher_ids uuid[],
  p_department text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select p_uid as uid, public.teacher_rank(p_uid) as rank
  )
  select
    -- ① 我是**在册教师**（teachers 里有一行），且**不是教室端账号**。
    --    这一条同时挡住"认不出的 uid"与"教室里那块屏"。
    exists (select 1 from teachers t, me where t.id = me.uid)
    and not exists (select 1 from classroom_accounts ca, me where ca.id = me.uid)
    -- ② 范围与身份对得上（逐档，只有这些组合成立）
    and case p_scope_kind
      when 'school' then
        -- 全校：校级三档 + 教务处 + 办公室 + 德育处 + 超管。
        -- 🔴 **年级主任 ❌、组长 ❌** —— 这是本行最要紧的一条边界（I46）：
        --    一位年级主任可以让全校老师的界面上弹出"全体教师周三开会"。
        --  ⚠️ 那一组值现在住在 `notice_can_publish_school_level()`（§21.2.2）里，
        --     因为 🆕`department` 那一支用的**就是它**（部门是校级单位）——
        --     抄两遍就是"改一处、漏一处"（I17）。
        --  ⚠️ 传 `p_uid` 而**不是** `me.uid`：这个 `select` 没有 FROM 子句
        --     （原来的写法只能在外层 with 里通过 `from me` 引用，直接写 `me.uid` 会
        --      `missing FROM-clause entry for table "me"` —— 本轮实测踩到）。
        public.notice_can_publish_school_level(p_uid)
      when 'department' then
        -- 🆕 发给某个职能部门（办公室 / 教务处 / 总务处 / 德育处）
        --  三半判据，缺一不可：
        --    · **部门代码认得出来**（认不出 = 不猜，直接 false）；
        --    · **这个部门里真的有人**（空了就拒 —— 否则发出去一条谁都收不到的通知）；
        --    · **我能发到校级单位那一档**（与 `school` 同一组人）——
        --      年级主任 / 组长**不许**给部门发：教务处 / 办公室的人就在这些部门里，
        --      那正是 §21.2 那条"下级通知上级，平台不承载"。
        coalesce(btrim(p_department), '') <> ''
        and public.notice_department_is_sendable(p_department)
        and public.notice_department_has_members(p_department)
        and public.notice_can_publish_school_level(p_uid)
      when 'grade' then
        -- 本年级：年级主任（自己那个年级）· 备课组长（自己那个年级）· 超管 / 教务处 / 德育处
        p_grade_id is not null
        and exists (
          select 1 from me
           where exists (select 1 from teacher_roles r
                          where r.teacher_id = me.uid and r.role in ('super','admin','moral_edu_head'))
              or exists (select 1 from teacher_roles r
                          where r.teacher_id = me.uid and r.role = 'grade_head'
                            and r.scope_type = 'grade' and r.scope_id = p_grade_id)
              or exists (select 1 from teacher_roles r
                          where r.teacher_id = me.uid and r.role = 'lesson_prep_lead'
                            and r.scope_type = 'grade_subject' and r.scope_id = p_grade_id)
        )
      when 'subject' then
        -- 本学科（跨年级）：教研组长 · 备课组长 · 超管 / 教务处
        --  ⚠️ 德育处 ❌（他不按学科说话）
        coalesce(btrim(p_subject_code), '') <> ''
        and exists (
          select 1 from me
           where exists (select 1 from teacher_roles r
                          where r.teacher_id = me.uid and r.role in ('super','admin'))
              or exists (select 1 from teacher_roles r
                          where r.teacher_id = me.uid
                            and r.role in ('subject_lead','lesson_prep_lead')
                            and r.subject_code = p_subject_code)
        )
      when 'grade_subject' then
        -- 本年级 + 本学科：备课组长（自己那一格）· 超管 / 教务处
        p_grade_id is not null
        and coalesce(btrim(p_subject_code), '') <> ''
        and exists (
          select 1 from me
           where exists (select 1 from teacher_roles r
                          where r.teacher_id = me.uid and r.role in ('super','admin'))
              or exists (select 1 from teacher_roles r
                          where r.teacher_id = me.uid and r.role = 'lesson_prep_lead'
                            and r.scope_type = 'grade_subject' and r.scope_id = p_grade_id
                            and r.subject_code = p_subject_code)
        )
      when 'role' then
        -- 发给"某个职位"：🔴 **只允许发给自己级别以下的档位**（§21.2）
        --  ⚠️ 判据是"**这个职位上真的有人**（取其中**最低**那一档的级别）**且**我比他高"。
        --     两半都不能省：
        --       · 少了"真的有人" → `notice_role_min_rank` 返回 null，
        --         而 `coalesce(...,0)` 会让 `me.rank > 0` 对**任何人**成立 →
        --         "发给一个根本不存在的职位"变成永远放行（**本轮实测踩到的那条漏洞**）；
        --       · 少了"我比他高" → 年级主任能直接给校长发通知。
        --  🔴 **另一半的边界同样是真的**：`notice_role_is_sendable` 那一半用的就是 §21.2 的
        --     **八档清单**（🆕 本轮把 `admin` 加了回来），而**校级三档**不在里面 →
        --     这一支对 `principal` 恒为 false，**连超管也是**
        --     （2026-09-28 实测：`notice_role_is_sendable('principal')=false`、
        --     `has_members=true`、`min_rank=80`、超管 `rank=100` —— 拒掉它的**不是**级别那一半）。
        --     ⚠️ 这不是待修的 bug：要给校长递话走**「全校」**那一档（`school` 按 teachers 行算，
        --     校长也在其中）；`custom` 那一支也够不着他（它同样要求被勾中的人有一档清单里的身份）。
        --     🆕 而 `admin` 已进清单：`min_rank('admin') ≥ 90`（`teacher_rank` 取 max），
        --     所以**只有超管**发得到它 —— 见 §21.2 那段"为什么不破坏那条口径"。
        public.notice_role_is_sendable(p_target_role)
        and public.notice_role_has_members(p_target_role)
        and exists (
          select 1 from me where me.rank > public.notice_role_min_rank(p_target_role)
        )
      when 'custom' then
        -- 勾人：**每一个**被勾中的人都必须是我能发给的人
        --   （存在 + 不是教室端 + **按他最低那一档**算，级别低于我）
        coalesce(array_length(p_teacher_ids, 1), 0) > 0
        and not exists (
          select 1 from unnest(p_teacher_ids) as t(tid)
           where not exists (select 1 from teachers tt where tt.id = t.tid)
              or exists (select 1 from classroom_accounts ca where ca.id = t.tid)
              or not exists (
                   select 1 from me
                    where me.rank > coalesce(public.notice_min_rank_of(t.tid), 0)
                      -- ⚠️ 「按最低那一档」在**没有角色行**时是 0：那一档正是任课教师（rank 1），
                      --    所以这里对"零角色行"的人允许（他比任何人都低）；
                      --    但对"教室端"已经在上面一句挡掉了。
                      and (
                        exists (select 1 from teacher_roles r
                                 where r.teacher_id = t.tid
                                   and r.role in (select * from notice_sendable_roles()))
                        or public.notice_is_plain_teacher(t.tid)
                      )
              )
        )
      else false
    end;
$$;

revoke all on function can_publish_notice_to_for(uuid, text, uuid, text, text, uuid[], text)
  from public, anon, authenticated;

-- 🔴 旧签名（六参，没有 `p_department`）**必须 drop 掉** —— 留着就是"同一件事两个入口"，
--    而且旧入口对 `'department'` 恒为 false（`case` 落到 `else false`）：
--    症状是"数据库说七种维度，其中一种怎么发都 403，而一行报错都没有"。
--    顺序上它是**后删**的那一半（新的七参版已经建在上面了）—— §10.1.1 同一条纪律。
drop function if exists public.can_publish_notice_to_for(uuid, text, uuid, text, text, uuid[]);

create or replace function public.can_publish_notice_to(
  p_scope_kind text,
  p_grade_id uuid,
  p_subject_code text,
  p_target_role text,
  p_teacher_ids uuid[],
  p_department text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select can_publish_notice_to_for(auth.uid(), p_scope_kind, p_grade_id,
                                   p_subject_code, p_target_role, p_teacher_ids,
                                   p_department) $$;

grant execute on function can_publish_notice_to(text, uuid, text, text, uuid[], text) to authenticated;

-- 同上：旧签名（五参）也要 drop 掉（新六参版已经建好了）
drop function if exists public.can_publish_notice_to(text, uuid, text, text, uuid[]);

-- -------- 21.5 收件人：**算出来的，不是存下来的**（方案 §九.3 ①）--------
--  给定一条通知，返回**这条通知的收件人 uid 集合**（只算通知自己的那些 target 行）。
--  🔴 它与 `can_publish_notice_to_for` 是**镜像**的：能发给谁 ↔ 谁能收到。
--     "能推出来的状态不许再存一份" —— 所以 `notice_targets` 里存的是**范围**，
--     而收件人每次读的时候**算**（成本：一个索引扫描 + 几个 exists）。
--
--  Q14 = A 的口径（用户拍板）：**"本年级的老师" = 在该年级的班上有任教关系的
--    + 该年级的班主任 / 年级主任 / 备课组长** —— 与 `visible_class_ids()` **同源**。
--
--  ⚠️ `heads` 那个 CTE 是**必须**的，别顺手删：`subject_lead` 那一支要问
--     "这个组长是不是也在本年级任课（`class_subjects`）"，而组长**很可能不带课** ——
--     少了它就是漏人（组长收不到自己年级的通知）。
create or replace function public.notice_recipient_ids_for(p_notice_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  with heads as (
    select nt.target_kind,
           nt.grade_id,
           nt.subject_code,
           nt.target_role,
           nt.teacher_id,
           nt.target_department
      from notice_targets nt
     where nt.notice_id = p_notice_id
  )
  select h.teacher_id
    from heads h
   where h.target_kind = 'teacher' and h.teacher_id is not null
  union
  -- 「全校」= 所有在册教师（**不含教室端** —— 教室端也有一行 teachers，见 §10.1）
  select t.id
    from heads h
    join teachers t on true
   where h.target_kind = 'school'
     and not exists (select 1 from classroom_accounts ca where ca.id = t.id)
  union
  -- 「本年级」= 在该年级的班上有任教关系 ∪ 该年级的班主任 / 年级主任 / 备课组长
  select x.uid from heads h cross join lateral (
    select cs.teacher_id as uid
      from class_subjects cs
      join classes c on c.id = cs.class_id
     where h.target_kind = 'grade' and c.grade_id = h.grade_id
    union
    select r.teacher_id
      from teacher_roles r
     where h.target_kind = 'grade' and r.scope_type = 'class' and r.role = 'head_teacher'
       and r.scope_id in (select c.id from classes c where c.grade_id = h.grade_id)
    union
    select r.teacher_id
      from teacher_roles r
     where h.target_kind = 'grade' and r.role = 'grade_head'
       and r.scope_type = 'grade' and r.scope_id = h.grade_id
    union
    select r.teacher_id
      from teacher_roles r
     where h.target_kind = 'grade' and r.role = 'lesson_prep_lead'
       and r.scope_type = 'grade_subject' and r.scope_id = h.grade_id
  ) x
  union
  -- 「本学科」（跨年级）= 在本校有该学科任教关系的老师 ∪ 该学科的组长
  select x.uid from heads h cross join lateral (
    select cs.teacher_id as uid
      from class_subjects cs
     where h.target_kind = 'subject' and cs.subject_code = h.subject_code
    union
    select r.teacher_id
      from teacher_roles r
     where h.target_kind = 'subject'
       and r.role in ('subject_lead','lesson_prep_lead')
       and r.subject_code = h.subject_code
  ) x
  union
  -- 「本年级 + 本学科」= 上面两条同时成立
  select x.uid from heads h cross join lateral (
    select cs.teacher_id as uid
      from class_subjects cs
      join classes c on c.id = cs.class_id
     where h.target_kind = 'grade_subject'
       and c.grade_id = h.grade_id and cs.subject_code = h.subject_code
    union
    select r.teacher_id
      from teacher_roles r
     where h.target_kind = 'grade_subject'
       and r.role in ('subject_lead','lesson_prep_lead')
       and r.subject_code = h.subject_code
       and (r.scope_type = 'subject' or r.scope_id = h.grade_id)
  ) x
  union
  -- 「某个职位」= 所有拿了这个职位的人（跨年级 / 跨学科；发的时候已经校验过级别）
  select r.teacher_id
    from heads h
    join teacher_roles r on r.role = h.target_role
   where h.target_kind = 'role'
  union
  -- 🆕「某个部门」= 归属这个部门的老师（**多对多，且可以一个都不属于** —— §21.2.2）。
  --   ⚠️ 与 `school` 那一支同一条纪律：教室端也有一行 `teachers`，但它不是"某个部门的人" ——
  --      这里显式挡掉（它本来也读不到通知，这一句是让"收件人集合"这句话本身是真的）。
  select td.teacher_id
    from heads h
    join teacher_departments td on td.department = h.target_department
   where h.target_kind = 'department'
     and not exists (select 1 from classroom_accounts ca where ca.id = td.teacher_id)
  union
  -- 🔴 「任课教师」这一档**要单独展开**（2026-09-28 实测踩到的一处漏人）：
  --    `teacher_roles.role = 'teacher'` 是一个**历史值**，现实里**没有任何一行**用它 ——
  --    任课教师的身份是 `class_subjects` 里的任课关系，**根本不写这张表**（§10.6）。
  --    所以"发给任课教师"如果只按 `role = 'teacher'` 去查，**一个人都发不到**，
  --    而那正是最常见的一档。这里的口径：**没有任何 `teacher_roles` 行的在册教师
  --    （不含教室端）就是"任课教师"那一档** —— 与 §10.6 对"任课教师"的定义逐字一致。
  select t.id
    from heads h
    join teachers t on true
   where h.target_kind = 'role' and h.target_role = 'teacher'
     and not exists (select 1 from teacher_roles r where r.teacher_id = t.id)
     and not exists (select 1 from classroom_accounts ca where ca.id = t.id);
$$;

revoke all on function notice_recipient_ids_for(uuid) from public, anon, authenticated;

-- 「我是不是这条通知的收件人」——读策略里那个 `in` 用得到它（一行一条通知的语义）
create or replace function public.is_notice_recipient_for(p_uid uuid, p_notice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.notice_recipient_ids_for(p_notice_id) x where x = p_uid
  );
$$;

revoke all on function is_notice_recipient_for(uuid, uuid) from public, anon, authenticated;

create or replace function public.is_notice_recipient(p_notice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select is_notice_recipient_for(auth.uid(), p_notice_id) $$;

grant execute on function is_notice_recipient(uuid) to authenticated;

-- -------- 21.6 「我能发给谁」的**范围清单**（前端用它摆选项，服务端每次都重判）--------
--  ⚠️ 它**不是**判据的第二处：它只是把 `can_publish_notice_to_for` 的结论**列出来**
--     给界面用（"摆不摆那个选项"），真正的闸门永远是服务端那一次 RPC（I46）。
--     前端拿它去 filter **数据行**是违规的（M3），但拿来摆**选项**正是它的用途。
--  返回：`{ scope_kind, grade_id, grade_name, subject_code, role_code, department_code }`
--        **六列**（🆕 本轮加了 `department_code`），行 = 一个可选范围。
--  🔴 **`returns table` 的形状变了 → 必须先 `drop` 再 `create`**：
--     Postgres 不许 `create or replace` 改返回类型（`cannot change return type of existing function`）。
--     裸版 `my_notice_scopes()` 同理（它的返回类型要跟着改），而且它的 `grant` 会随 drop 一起没了，
--     所以下面那一份**必须重新 grant** —— 漏了这一句 = 服务端 RPC 当场 403（整个通知页死掉）。
drop function if exists public.my_notice_scopes_for(uuid);
create or replace function public.my_notice_scopes_for(p_uid uuid)
returns table (
  scope_kind text,
  grade_id uuid,
  grade_name text,
  subject_code text,
  role_code text,
  department_code text
)
language sql
stable
security definer
set search_path = public
as $$
  -- 全校
  select 'school'::text, null::uuid, null::text, null::text, null::text, null::text
   where public.can_publish_notice_to_for(p_uid, 'school', null, null, null, null, null)
  union all
  -- 本年级（逐年级）
  select 'grade'::text, g.id, g.name, null::text, null::text, null::text
    from grades g
   where public.can_publish_notice_to_for(p_uid, 'grade', g.id, null, null, null, null)
  union all
  -- 本学科（逐学科）
  select 'subject'::text, null::uuid, null::text, s.code, null::text, null::text
    from subjects s
   where public.can_publish_notice_to_for(p_uid, 'subject', null, s.code, null, null, null)
  union all
  -- 本年级 + 本学科（逐组合）
  select 'grade_subject'::text, g.id, g.name, s.code, null::text, null::text
    from grades g, subjects s
   where public.can_publish_notice_to_for(p_uid, 'grade_subject', g.id, s.code, null, null, null)
  union all
  -- 某个职位（逐档；级别不够的那些**不会出现**）
  select 'role'::text, null::uuid, null::text, null::text, r, null::text
    from public.notice_sendable_roles() r
   where public.can_publish_notice_to_for(p_uid, 'role', null, null, r, null, null)
  union all
  -- 🆕 某个职能部门（逐部门；**空部门不会出现** —— `notice_department_has_members()` 那一半）
  select 'department'::text, null::uuid, null::text, null::text, null::text, d
    from public.notice_departments() d
   where public.can_publish_notice_to_for(p_uid, 'department', null, null, null, null, d);
$$;

revoke all on function my_notice_scopes_for(uuid) from public, anon, authenticated;

-- ⚠️ 裸版也要 **drop + create**（返回类型变了），而且 drop 会带走它原来的 grant ——
--    所以下面这一句 `grant` **不是重复的**：少了它，服务端 `my_notice_scopes` 当场
--    `permission denied for function`（整个"发通知"页看到的是"数据库没给出任何范围"）。
drop function if exists public.my_notice_scopes();
create or replace function public.my_notice_scopes()
returns table (
  scope_kind text,
  grade_id uuid,
  grade_name text,
  subject_code text,
  role_code text,
  department_code text
)
language sql
stable
security definer
set search_path = public
as $$ select * from my_notice_scopes_for(auth.uid()) $$;

grant execute on function my_notice_scopes() to authenticated;

-- -------- 21.7 读策略（**本段唯一改权限的一步**）--------
--  看得见这条通知 =
--      未撤下 and 未过期 and 我不是教室端
--      and ( 我发的  or  我在它的某个范围的收件人集合里 )
--
--  ⚠️ 三个条件缺一不可：
--    · `revoked_at is null` / `expires_at` —— 撤下与过期都只是"不再出现在默认列表里"，
--      **行还在**（历史仍可查，见 §21.3 的注释）；
--    · `not is_classroom_account()` —— **这是 §九.5 那条决定的唯一实现处**（I47）。
--      少了它，教室里那块屏上就会出现"全体教师周三开会"。
--    · `sender_id = auth.uid()` —— **自己发的永远看得见**（I25 的同一条纪律）。
--      修不修都不影响别人：它只让"发件人自己看得见自己发的那条"，
--      **不会**把范围外的收件人放进来。
--  🔴 **策略里只能调"grant 给 authenticated 的那一半"**（2026-09-28 收尾轮实测踩到的第二个坑）：
--     策略表达式是**以调用者的身份**求值的 —— `security definer` 只决定函数**内部**以谁的身份读表，
--     **不免除**"调用者得先有 EXECUTE 权限"这一关。第一版这里写的是
--     `exists (select 1 from notice_recipient_ids_for(notices.id) x where x = auth.uid())`，
--     而 `_for` 那一半是**故意 revoke 掉**的（I33）→ 任何老师读通知都当场
--     `permission denied for function notice_recipient_ids_for`（**整个收件箱是死的**，
--     而且不报 SQL 错的那一半看起来还像"读得到 0 行"）。
--     → 判据的两件套在这里的用法：策略调**裸版** `is_notice_recipient()`（grant 给 authenticated），
--       `_for` 那半只给核对（SQL 编辑器 / `rls-checks` 以属主身份跑）用。
drop policy if exists notices_visible on notices;
create policy notices_visible on notices for select to authenticated
  using (
    revoked_at is null
    and (expires_at is null or expires_at > now())
    and not is_classroom_account()
    and (
      sender_id = auth.uid()
      or is_notice_recipient(notices.id)
    )
  );

--  ⚠️ 为什么 `notice_targets` 也要一条自己的策略：`notice_recipient_ids_for` 是
--     **security definer**（它读 target 行时不走策略），所以**读通知本身**不依赖这一条。
--     但前端要显示"这条通知发给谁"（"@高二全体老师"那种副标题）就得读得到 target 行 ——
--     口径与通知**逐字相同**：看得见那条通知，就看得见它的范围。
--  🔴 这一条**同样只能调裸版** `is_notice_recipient()`（理由见上面那段：策略以调用者身份求值，
--     而 `_for` 那半已 revoke）。
--  🔴 这也意味着**教室端连"发给谁"都读不到** —— 与 I47 同一条边界，不是两处。
drop policy if exists notice_targets_visible on notice_targets;
create policy notice_targets_visible on notice_targets for select to authenticated
  using (
    not is_classroom_account()
    and exists (
      select 1 from notices n
       where n.id = notice_targets.notice_id
         and n.revoked_at is null
         and (n.expires_at is null or n.expires_at > now())
         and (
           n.sender_id = auth.uid()
           or is_notice_recipient(n.id)
         )
    )
  );

-- -------- 21.8 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 逐身份的"我能发给谁"（把 uuid 换成要核对的老师 id）：
--  with me as (select '00000000-0000-0000-0000-000000000000'::uuid as uid)
--  select scope_kind, grade_name, subject_code, role_code, department_code
--    from my_notice_scopes_for((select uid from me)) order by 1,2,3,4,5;
--  期望：年级主任**没有** scope_kind='school'、也**没有** 'department' 那一行；
--        教研组长有 'subject'、没有 'school'/'department'；
--        超管**多一行** `role / admin`（🆕 本轮把教务处主任加回了清单）。
--
--  ② 逐身份的"我看得到几条通知"（同上换 uuid）：
--  with me as (select '00000000-0000-0000-0000-000000000000'::uuid as uid)
--  select
--    (select count(*) from notice_recipient_ids_for(n.id) x where x = (select uid from me)) as 我是收件人,
--    public.can_publish_notice_to_for((select uid from me), 'school', null, null, null, null, null) as 能给全校发,
--    public.can_publish_notice_to_for((select uid from me), 'department', null, null, null, null, 'academic') as 能给教务处发
--  from notices n order by 1 desc;
--
--  ③ 🆕 部门归属：谁能维护、"教务处里都有谁"（把 uuid 换成要核对的老师 id）
--  -- select t.name, td.department from teacher_departments td join teachers t on t.id = td.teacher_id
--  --  order by td.department, t.name;
--  -- 维护判据 = `can_create_teacher_accounts_for(uid)`（超管 / 教务处 / 办公室主任）——
--  -- **不是** `can_assign_roles_for`：部门是**档案属性**，不是身份（§21.2.2）。
--
--  ④ 🔴 教室端那一条（**这条必须是 0**）：教室端账号的 uid 拿去问，
--     `notices` 上的策略会把它筛掉 —— 在 SQL 编辑器里跑不了（那里 auth.uid() 是 null），
--     所以它钉在 `app/scripts/rls-checks.mjs` 第二·之四 / 之二·之五节（真 PGlite + 假 JWT）。
-- ============================================================

-- ============================================================
--  22. 全站公告（2026-09-28 公告轮）—— 「**平台**对老师说话」
--      设计见 `功能设计与不变量.md` §二十四 · 参考实现 `医路相伴/index.html` 的
--      `announcements` + `renderSiteAnnBar`（**只借形态，不搬数据模型**）
--
--  🔴🔴 **读这一节之前先记住：公告 ≠ 通知（这是本仓库最容易搞混的一处）**
--
--     · **通知**（`notices`，§21）＝ **教务通知**：各职能部门（教务处 / 办公室 / 德育处 /
--       年级主任 / 组长）**发给老师**的事，有**收件范围**（七种维度）、有未读红点、
--       有 `/notices` 收件箱页、工作台一块。**它问的是"这件事跟我有没有关系"。**
--     · **公告**（`announcements`，本节）＝ **全站公告**：**关于平台本身**的信息
--       （"系统今晚维护"、"新功能上线"、"使用提醒"），**全站一条**、
--       **没有收件范围、没有收件人、没有未读**。形态是**顶部横幅 + 可选弹窗**。
--       **它问的是"这个平台现在是什么状态"。**
--     · **两者各自独立，一个字都不许互相塞**：
--       ⛔ 不许把公告塞进 `notices`（那会让"全校老师"变成公告的收件范围 —— 公告没有范围）；
--       ⛔ 不许给 `notices` 加 `level` / `popup` / `active_from` 这类列
--          （教务通知不弹窗、不分等级 —— 那是公告的字段）；
--       ⛔ 不许让公告搭 §21 那套收件人函数的车（`notice_recipient_ids_for` 与本节无关）。
--     ⚠️ 用户 2026-09-28 的原话（推翻了 `管理台第二期方案.md` §二.0 原来的判决）：
--        「**不同意**，这个通知是发给整个平台的**关于平台的信息类通知**，
--         和各个职能部门发的**教务通知**不同」。
--        → 那一节原写"不新建任何公告实体"，本轮**按用户口径推翻**，该文档已加更正说明。
--
--  🔴 **谁能发：只有超管**（用户口径"公告是关于平台本身的" → 它是**平台运维**的事）。
--     ⚠️ 这一条是**执行方按用户口径推定的**（用户没有逐字说"只有超管能发公告"），
--        报告里单列。判据**只在数据库**（`can_publish_announcement_for`），
--        前端只决定"摆不摆入口"（入口在 `/admin` 面板里，`visibleFor: isSuperAdmin`）。
--
--  ⚠️ 一个字段一种语义（本节最要紧的一条）：
--     `level` 只回答"**多显眼**"（普通 / 重要 / 紧急），
--     `popup` 只回答"**弹几次**"（不弹 / 每人一次 / 每会话一次 / 每次都弹）。
--     参照项目把两者混着用（`level='urgent'` 会**顺带**改弹窗行为），本节**不混**：
--     `level` 唯一影响弹窗的地方是 `popup='never'` 时给**紧急**留的那一个例外（见 §22.2 注）。
--
--  本段可重复执行（幂等）：只新增对象（一张表 + 两个判据函数 + 一条读策略），
--  **不动任何既有对象**。
-- ============================================================

-- -------- 22.1 建表 --------
--  ⚠️ 写入**只走服务端** `POST /api/announcement`（service_role，绕过 RLS）——
--     所以这张表**没有一条 insert/update/delete 策略**（与 §21.3 的 `notices` 同一条纪律）。
--     这不是"忘了写"：多一条写策略就多一个前端能绕过的口子，
--     而"谁能发"必须在服务端问数据库（§22.2）。**同一不变量在所有写入路径上守。**
create table if not exists announcements (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid references schools (id) on delete set null,
  title          text not null default '',
  -- 纯文本。**不做富文本**（与 notices 同一条纪律）：富文本 = XSS 面 + 排版调试，
  -- 而且公告是"一句话说清平台状态"的地方，不是公告板文章
  body           text not null default '',
  -- 等级：只决定"**多显眼**"。三值由 check 钉死（与前端 `AnnouncementLevel` 同一组）
  --   normal    普通 —— 只出现在滚动条里
  --   important 重要 —— 排序靠前（同置顶档之下）+ **加粗**
  --   urgent    紧急 —— 用最重的底色；且 `popup='never'` 时**仍然按"每会话一次"弹**
  level          text not null default 'normal'
                 check (level in ('normal','important','urgent')),
  -- 弹窗：只决定"**弹几次**"。四值由 check 钉死
  --   never   不弹（`level='urgent'` 那一个例外见 §22.2 注）
  --   once    每人一次 —— 关掉时记进 **localStorage**（`shugao.ann.seen`）
  --   session 每会话一次 —— 弹出时记进 **sessionStorage**（`shugao.ann.sessSeen`）
  --   always  每次访问都弹（慎用；它每次开页面都打断人）
  popup          text not null default 'never'
                 check (popup in ('never','once','session','always')),
  -- 置顶：排在**所有**公告之前（与 `level` 是两个维度：一个说"钉住"，一个说"多重"）
  pin            boolean not null default false,
  -- 生效区间（**闭区间，两端都含**）：
  --   `active_from` 为空 = **立即生效**（等价于 -∞）
  --   `active_to`   为空 = **不过期**（等价于 +∞）
  --   ⚠️ 过期**不删行**：它只是"不再出现在横幅/弹窗里"，历史仍可查（与 `revoked_at` 同一条纪律）
  active_from    timestamptz,
  active_to      timestamptz,
  -- ---- 邮件四列：🆕 **本轮不做邮件发送，列先留** ----
  --  🔴 报告里说清楚：这四列**只建、不写、界面不显示**。留着的唯一理由是
  --     "将来要加发送时不用做迁移"（参照项目用它记"发过几封 / 失败几封"）。
  --     `email_sent` = 有没有发过；`email_sent_ts` = 最后一次发送时刻；
  --     `email_count` = 成功封数；`email_fail` = 失败封数（四列语义互不重叠）。
  email_sent     boolean not null default false,
  email_sent_ts  timestamptz,
  email_count    integer not null default 0,
  email_fail     integer not null default 0,
  -- 谁建的 / 谁最后改的。⚠️ 用 `on delete set null`（**不是 cascade**）：
  --    删掉一位老师不该连带删掉公告 —— "这条公告曾经存在过吗"要能回答
  created_by     uuid references teachers (id) on delete set null,
  updated_by     uuid references teachers (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- 撤下时刻（为空 = 有效）。⚠️ **撤下不删行**（与 §21.3 的 `revoked_at` 逐字同一条纪律）
  revoked_at     timestamptz,
  -- 区间本身要自洽：两端都写了就必须"结束晚于开始"（否则那条公告**永远不会生效**，
  -- 而列表里多出一条谜）。只写一端一律放行（那一端是 ±∞）
  constraint announcements_active_range_check
    check (active_to is null or active_from is null or active_to > active_from)
);
-- 「按时间倒序列出」是这张表唯一的热路径 —— 公告是**个位数条**的表，不需要更多索引
create index if not exists announcements_created_idx on announcements (created_at desc);

-- -------- 22.2 判据：**谁能发公告**（本能力的全部安全性都在它身上）--------
--  🔴 判据一律走 `_for` / 裸版**两件套**（I33），与 §21.4 完全同款：
--     `_for` 接受任意 uid = "以任意人身份问一句能不能发公告" → **一律 revoke**，
--     只留给属主核对（SQL 编辑器 / `rls-checks`）；裸版 grant 给 authenticated，
--     服务端 `POST /api/announcement` 拿**调用者自己的 JWT** 走
--     `POST /rest/v1/rpc/can_publish_announcement` 问它。
--
--  三半判据，缺一不可（与 `can_publish_notice_to_for` 的第 ① 条同一套写法）：
--    ① `is_super_admin_for(uid)` —— **只有超管**（用户口径：公告是关于平台本身的）；
--    ② `teachers` 里有一行 —— 挡住"认不出的 uid"（service_role 那条路不能凭一个幽灵 id 写库）；
--    ③ **不是教室端** —— 教室里那块屏是给学生看的，它不是"发公告的人"
--       （超管本来就不会是教室端，这一半是**让这句话本身是真的**，与 §21.5 同一条纪律）。
--  ⚠️ 判据链上**每一个**函数都必须是 `security definer`（§21.2.1 那次实测的教训）。
create or replace function public.can_publish_announcement_for(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin_for(p_uid)
     and exists (select 1 from teachers t where t.id = p_uid)
     and not exists (select 1 from classroom_accounts ca where ca.id = p_uid);
$$;

revoke all on function can_publish_announcement_for(uuid) from public, anon, authenticated;

create or replace function public.can_publish_announcement()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_publish_announcement_for(auth.uid()) $$;

grant execute on function can_publish_announcement() to authenticated;

--  ⚠️ `level` 与 `popup` 的分工里，那条例外（`popup='never'` + `level='urgent'`
--     仍然按"每会话一次"弹）落在**读侧**，不在 SQL：实现只有一处 ——
--     `app/src/lib/announcements.ts` 的 `shouldPopup()`（`nav-checks` 的 A10 逐条断言，
--     含 `never+urgent` 那一个例外；`rls-checks` 只管 `popup` / `level` 的 check 约束）。

-- -------- 22.3 RLS：**只有一条读策略**（读得宽、写得窄）--------
alter table announcements enable row level security;
grant select on announcements to authenticated;
revoke all on announcements from anon;

--  看得见一条公告 = **未撤下** and **在生效区间内** and **我不是教室端**。
--
--  🔴 三条都写在这里，**前端一个字都不筛**（M3 / §11.3）：`/admin` 面板里的公告列表
--     走的是服务端 service_role（超管才拿得到），教师端横幅走的**就是这条策略**。
--  🔴 **没有 `insert/update/delete` 策略**（与 §21.3 同一条）：写只走服务端。
--  ⚠️ 与通知**唯一**相同的一条边界：教室端读不到（I47 的同一条：那块屏是给学生看的，
--     而"平台今晚维护"这类话里会出现内部信息）。**这不是"照抄通知"，是同一个理由。**
--  ⚠️ 边界是**闭区间**：`active_from <= now()` 且 `active_to >= now()`（两端都含）——
--     §22.1 的 check 保证了两端都写时 `active_to > active_from`。
--  ⚠️ 策略里只调**grant 给 authenticated 的那一半**（`is_classroom_account()`，§10 已 grant）
--     —— 这是 §21.7 那次 `permission denied for function` 的教训：
--     策略表达式以**调用者**的身份求值，`security definer` 不免除 EXECUTE 权限那一关。
drop policy if exists announcements_visible on announcements;
create policy announcements_visible on announcements for select to authenticated
  using (
    revoked_at is null
    and (active_from is null or active_from <= now())
    and (active_to   is null or active_to   >= now())
    and not is_classroom_account()
  );

-- -------- 22.4 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 表上只有一条策略、且只有 select（写入只走服务端）：
--  -- select tablename, policyname, cmd from pg_policies where tablename = 'announcements';
--  -- 期望：announcements | announcements_visible | SELECT —— **只有这一行**
--
--  ② 谁发得到（把 uuid 换成要核对的老师 id）：
--  -- select public.can_publish_announcement_for('00000000-0000-0000-0000-000000000000'::uuid) as 超管;
--  -- 期望：超管 true；校长 / 教务处 / 办公室主任 / 德育处主任 / 年级主任 / 教研组长 /
--  --       备课组长 / 班主任 / 任课教师 / 教室端 **全 false**
--  --       （公告不是"学校对老师说话"，所以 §21 那套 `can_publish_notice_to` 一个字都不相关）
--
--  ③ 生效区间（过期 / 未生效都不该出现在教师端）：
--  -- select title, level, popup, pin, active_from, active_to, revoked_at from announcements
--  --  order by created_at desc;
--
--  ④ 教室端读不到那一条（**这条必须是 0 行**）：钉在 `app/scripts/rls-checks.mjs`
--     第二·之六节（真 PGlite + 假 JWT）—— SQL 编辑器里跑不了（那里 auth.uid() 是 null）。
-- ============================================================


-- ============================================================
--  23. 平台设置：**维护模式**（2026-09-29 管理台第二期）—— 「平台对自己说话」
--      设计见 `管理台第二期方案.md` §二.3 · 落地口径见 `功能设计与不变量.md` §二十五
--
--  🔴🔴 **读这一节之前先记住：维护 ≠ 公告 ≠ 通知**（三个东西，三种收件人）
--
--     · **通知**（`notices` §21）＝ 学校对老师说话（有收件范围、有未读）；
--     · **公告**（`announcements` §22）＝ 平台对老师说话（全站一条、横幅 + 弹窗）；
--     · **维护**（本节）＝ **平台现在还开不开门**。它不是"一条消息"，
--       而是一个**状态**：匿名可读（未登录的人也要知道"现在进不去"）、
--       有**时间窗**（到点自动开 / 到点自动关）、**超管自己不受影响**。
--     ⛔ 不许用一条置顶公告代替它（教室端读不到公告、公告靠人点进去看、
--        而维护要的是"进门就被拦"）；⛔ 也不许给 `announcements` 加 `enabled` 列
--        （那是把"一个状态"塞进"一篇文章"里）。
--
--  🔴 **谁都能读、只有超管能写**：
--     · 读：**只有一个公开出口** `GET /api/status`（**只回 3 个字段**）；
--       这张表**一条策略都不建**，而且对 anon / authenticated **连 SELECT 都不给**
--       —— 一旦给了，将来往这张表里放任何东西都变成匿名可见。
--     · 写：**只有一个出口** `POST /api/admin/maintenance`（service_role，
--       判据 = `is_super_admin()`，**不是** `can_manage_teachers()`）。
--
--  ⚠️ 本段可重复执行（幂等）：只新增对象（两张表 + 一行种子），不动任何既有对象。
-- ============================================================

-- -------- 23.1 操作留痕（`admin_audit`）--------
--  🔴 为什么要有它（而这一版**刻意不建"谁看过什么"那种浏览留痕**，见 §20.2）：
--     维护模式是**唯一一个能把全校锁住**的动作，删错误日志是**不可逆**的动作。
--     这两种"改动了系统的状态"的事必须留一句"谁、什么时候、改成了什么"。
--     ⚠️ 它与"谁看了什么"是两件事：这里只记**写动作**（开/关维护、删日志、发信），
--        不记任何一次读。
--  ⚠️ 表名刻意叫 `admin_audit` 而不是 `maintenance_log`：它记的是**平台侧写动作**，
--     维护只是第一个用它的功能（第二个是删错误日志 / 发信计数）。
create table if not exists admin_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  -- 谁做的。⚠️ `on delete set null`（**不是 cascade**）：人走了不等于那件事没发生
  actor_id    uuid references teachers (id) on delete set null,
  -- 名字**快照**：账号删了之后这一行还要能被人读懂
  actor_name  text not null default '',
  -- 动作代码，形如 `maintenance.on` / `errors.delete` / `mail.test`（见 §23.2 与相关接口）
  action      text not null default '',
  -- 作用对象（被删的 id / 清理的截止日期 / 邮件收件人），纯文本，不回显任何正文
  target      text not null default '',
  -- 一句人话的补充（**不许放学生数据**：这张表会被一起备份，见 §二十四 的同一句纪律）
  detail      text not null default '',
  -- 影响行数（删了几条 / 发了几封）。默认 0，不是"未知"
  affected    integer not null default 0
);
-- 「最近的写动作」是这张表唯一的热路径 —— 它是个位数/百位数条的表
create index if not exists admin_audit_at_idx on admin_audit (at desc);
-- 📩 发信配额要数"最近 24 小时发了几封"（Resend 免费额度 100 封/天）
create index if not exists admin_audit_action_idx on admin_audit (action, at desc);

alter table admin_audit enable row level security;
-- 🔴 **一条策略都不建，而且连 SELECT 都不给**：读只走服务端（超管接口）。
--    理由与 `site_state` 逐字相同：这张表将来会长出别的东西，
--    "建了策略再想"就是"将来某一天它匿名可见了"。
revoke all on admin_audit from anon, authenticated;

-- -------- 23.2 维护模式状态（`site_state`，`key='maintenance'`）--------
--  ⚠️ 用 `key` 做主键（而不是"只有一行"）：将来别的小开关（例如"只读模式"）
--     往同一个表里加一行即可，不用再建一张设置表。
--  ⚠️ 字段是**显式列**而不是一个 `jsonb`：显式列能在数据库这一层写 check
--     （`until > scheduled_from`），而 jsonb 里那个约束只能靠应用层 ——
--     "表自己守得住"是本仓库一贯的口径（与 `announcements_active_range_check` 同款）。
create table if not exists site_state (
  key             text primary key,
  -- 超管的**开关意图**（一个字段一种语义）。⚠️ "现在到底是不是维护中"要把这一列
  -- 与下面两个时刻一起算 —— 判据只有一处：服务端 `maintenanceEffective()`
  -- （`functions/api/_lib/maintenance.ts`，前端那份同名函数只用于面板预览）。
  enabled         boolean not null default false,
  -- 给全校看的通告正文（服务端截断到 200 字）。空 = 用默认文案
  message         text not null default '',
  -- 自动关闭时刻。空 = 不自动关（⚠️ 服务端在开启时**强制**写它，默认 now()+4h）
  until           timestamptz,
  -- 定时开启时刻。空 = 不是定时开启（`enabled` 立刻生效）
  scheduled_from  timestamptz,
  updated_by      uuid references teachers (id) on delete set null,
  updated_at      timestamptz not null default now(),
  -- 区间自洽：两端都写了就必须"结束晚于开始"（否则那一段永远不生效，
  -- 而界面上会多出一条谜 —— 与 §22.1 的 `announcements_active_range_check` 同一条纪律）
  constraint site_state_range_check
    check (until is null or scheduled_from is null or until > scheduled_from)
);

insert into site_state (key) values ('maintenance') on conflict (key) do nothing;

alter table site_state enable row level security;
-- 🔴 读也只有一个公开出口（`GET /api/status`）—— 所以这里**连 SELECT 都不给**。
--    给前端 select 这张表的权限 = 将来往里放任何东西都匿名可见（方案 §二.3 原文）。
revoke all on site_state from anon, authenticated;

-- -------- 23.3 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 两张表上一共几条策略（**必须都是 0 行**）：
--  -- select tablename, policyname, cmd from pg_policies
--  --  where tablename in ('site_state','admin_audit');
--  -- 期望：（0 行）
--
--  ② 连 SELECT 都没给（**这两条也必须都是 false**）：
--  -- select has_table_privilege('anon','site_state','select') as anon读,
--  --        has_table_privilege('authenticated','site_state','select') as 老师读;
--
--  ③ 种子行在（`key='maintenance'`，未开启）：
--  -- select key, enabled, message is null as 消息为空, until, scheduled_from from site_state;
-- ============================================================


-- ============================================================
--  24. 前端错误日志（2026-09-29 管理台第二期 · `frontend_errors`）
--      设计见 `管理台第二期方案.md` §二.4
--
--  🔴 **它为什么必须存在**：教师端与教室端出问题时，**现场只有那块屏**。
--     `syncError` 只留"上一次写库失败的原因"（一个字符串槽位，没有时间没有历史，
--     见 §十 留档的"老师说他改了、刷新就没了"），而浏览器里的 JS 异常
--     **一个字都没留下**。这张表就是那条流水。
--
--  🔴 **上报是本项目唯一一个对匿名开放的写接口**（登录页 / 教室端 / hydrate 失败
--     这三个现场**都没有会话**，而那正是最该报上来的三种）。所以它比别的写路径多四道：
--     ① **限流**（同一人 5 分钟 ≤ 20 条 + 全表 5 分钟 ≤ 200 条兜底）；
--     ② **每个字段都在服务端截断**（不信前端）；
--     ③ **回话里绝不回显正文**（否则它就成了一个"写进去能读回来"的通道）；
--     ④ **超限返回正常 JSON**（`{ok:false,reason:'rate-limited'}`，**不是错误码**）。
--
--  🔴 **隐私：B 类（可能升到 C，所以要防）**。`message` / `stack` 里**可能夹到学生姓名**
--     （例：`throw new Error('张三这次没交')`、或 Postgres 的
--     `Key (student_no)=(20230115) already exists`）。三条措施：
--     ① 这张表里**根本没有**学生字段（不是"界面不渲染"，是**想显示都显示不出来**）；
--     ② 读只走服务端（超管），界面复用第一期的 `PrivacyLine`（"请勿投屏或截图"）；
--     ③ `has_pii` 用**窄启发式**标出来（邮箱 / 连续 15+ 位数字），
--        ⚠️ 屏上必须写明**它是启发式**，绝不许写成"已脱敏"。
--
--  ⚠️ 本段可重复执行（幂等）。
-- ============================================================

-- -------- 24.1 建表 --------
create table if not exists frontend_errors (
  id            bigint generated always as identity primary key,
  -- 谁报的。未登录 = null（游客 / 登录页 / 教室端还没有会话时）
  account_id    uuid references teachers (id) on delete set null,
  username      text not null default '',   -- left(…,60)  快照：人不在册了也读得懂
  role          text not null default '',   -- left(…,40)  身份标签快照
  view          text not null default '',   -- left(…,120) 页面路径 / 活动视图
  message       text not null default '',   -- left(…,500) 空则 '未知错误'
  stack         text not null default '',   -- left(…,2000)
  ua            text not null default '',   -- left(…,300)
  env           text not null default '',   -- left(…,20)  'web' | 'kiosk'
  -- 🔴 本项目独有的一列：上报那一刻 `store.syncError` 的原文。
  --    §十 留档过「老师说他改了、刷新就没了」—— 有了它，才有可能把
  --    "页面崩了"与"写入被静默拒绝"关联起来。⚠️ **这不是 D1/D2**：
  --    它只是顺手把现场那一句话带回来，不改 `syncError` 的形态。
  sync_error    text not null default '',   -- left(…,300)
  -- 启发式标出来"这条可能含学生信息"（见文件头 ③）
  has_pii       boolean not null default false,
  ts            timestamptz not null default now()
);
-- 「最近 24 小时」与「按时间倒序列出」是这张表唯一的热路径
create index if not exists frontend_errors_ts_idx on frontend_errors (ts desc);
-- 限流要按"同一人在最近 5 分钟"数行
create index if not exists frontend_errors_account_idx on frontend_errors (account_id, ts desc);
create index if not exists frontend_errors_username_idx on frontend_errors (username, ts desc);

alter table frontend_errors enable row level security;
-- 🔴 读只走服务端（超管接口 `/api/admin/errors`）→ 一条策略都不建、SELECT 也不给。
revoke all on frontend_errors from anon, authenticated;

-- -------- 24.2 上报（`report_frontend_error`）--------
--  🔴 **唯一一处实现"截断 + 限流 + 洗一遍"**。前端（`src/lib/errors.ts`）只负责
--     调用它，并且**自己那一层也限流**（每会话同一条错误最多 2 条、总计 10 条）
--     —— 两层限的不是同一件事：前端那层是"别让一个崩溃循环把页面拖死"，
--     这一层是"别让任何人把这张表撑爆"。
--  ⚠️ `security definer`：它要绕过"表上一条策略都没有"往表里写。
--     因为它是 definer，**每一条入参都必须当成敌意输入**（这就是它存在的理由）。
create or replace function public.report_frontend_error(
  p_username   text default '',
  p_role       text default '',
  p_view       text default '',
  p_message    text default '',
  p_stack      text default '',
  p_ua         text default '',
  p_env        text default '',
  p_sync_error text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- ① 截断（长度常量与服务端 `functions/api/errors.ts` 逐字相同，见那边的注释表）
  v_username text := left(coalesce(p_username, ''), 60);
  v_role     text := left(coalesce(p_role, ''), 40);
  v_view     text := left(coalesce(p_view, ''), 120);
  -- ⚠️ 空消息归一成 '未知错误'（**不是空串**）：屏上一行空白比"未知错误"更难查
  v_message  text := left(coalesce(nullif(btrim(coalesce(p_message, '')), ''), '未知错误'), 500);
  v_stack    text := left(coalesce(p_stack, ''), 2000);
  v_ua       text := left(coalesce(p_ua, ''), 300);
  v_env      text := left(coalesce(p_env, ''), 20);
  v_sync     text := left(coalesce(p_sync_error, ''), 300);
  -- 限流的"人"：登录了按 auth.uid()，没登录按自报的 username（匿名没有 IP 可用，
  -- 见 `功能设计与不变量.md` §二十五「已知边界」那一条 —— 明说这是"限洪"）
  v_key      text := coalesce(auth.uid()::text, v_username);
  v_mine     integer;
  v_all      integer;
  v_pii      boolean;
  v_id       bigint;
begin
  -- ② 限流一：同一人 5 分钟 ≤ 20 条
  select count(*) into v_mine
    from frontend_errors e
   where e.ts > now() - interval '5 minutes'
     and coalesce(e.account_id::text, e.username) = v_key;
  if v_mine >= 20 then
    -- ⚠️ **正常 JSON + 200**（不是错误码）：超限不是"出错"，前端什么都不用做
    return jsonb_build_object('ok', false, 'reason', 'rate-limited', 'scope', 'account');
  end if;

  -- ③ 限流二：全表 5 分钟 ≤ 200 条（匿名可以换 username 绕过限流一，这层挡洪水）
  select count(*) into v_all from frontend_errors e where e.ts > now() - interval '5 minutes';
  if v_all >= 200 then
    return jsonb_build_object('ok', false, 'reason', 'rate-limited', 'scope', 'global');
  end if;

  -- ④ 洗一遍：**URL 的 query string 一律抹掉**（`?access_token=…` / `?roles=…` 都不能进这张表）
  --    ⚠️ 前端也洗（`lib/errors.ts` 的 `scrubForReport`），但**不指望前端** ——
  --       手打这个 RPC 的人不会洗（I49 的"服务端要再洗一遍"）。
  v_message := regexp_replace(v_message, '(https?://[^?\s]+)\?[^\s]*', '\1', 'g');
  v_stack   := regexp_replace(v_stack,   '(https?://[^?\s]+)\?[^\s]*', '\1', 'g');

  -- ⑤ `has_pii`：**窄启发式**（邮箱 / 连续 15+ 位数字）。
  --    ⚠️ 它会有漏、也可能误标 —— 界面上必须写明"启发式"，**不许写成"已脱敏"**。
  --    ⚠️ 刻意**不做**"查库里有没有这个学生姓名"那一条：一次上报查一次全校名单，
  --       成本与隐私都不划算（方案 §二.4 的建议也是只做前两条）。
  v_pii := (v_message || ' ' || v_stack) ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
        or (v_message || ' ' || v_stack) ~ '[0-9]{15,}';

  insert into frontend_errors
    (account_id, username, role, view, message, stack, ua, env, sync_error, has_pii)
  values
    (auth.uid(), v_username, v_role, v_view, v_message, v_stack, v_ua, v_env, v_sync, v_pii)
  returning id into v_id;

  -- ⑤ 回话里**只有 id 与有没有疑似隐私**，**绝不回显正文**（那会变成读回通道）
  return jsonb_build_object('ok', true, 'id', v_id, 'has_pii', v_pii);
end $$;

-- 🔴 这个函数**故意** grant 给 anon：登录页 / 教室端 / hydrate 失败三个现场都没有会话。
--    它是本项目唯一一个对匿名开放的函数（`ocr.ts` 是"无鉴权"的反例，不是先例）。
grant execute on function report_frontend_error(text, text, text, text, text, text, text, text)
  to anon, authenticated;

-- -------- 24.3 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 表上 0 条策略：
--  -- select policyname from pg_policies where tablename = 'frontend_errors';  -- 期望 0 行
--
--  ② 匿名能上报、但**读不到**（这两条一起看才是重点）：
--  -- select public.report_frontend_error('测试','teacher','/x','探针','','','web','');
--  -- select count(*) from frontend_errors;   -- 以 anon 身份：42501 权限不足（不是 0 行）
--
--  ③ 截断真的生效（插一条 800 字的，回来看长度）：
--  -- select length(message) as 消息长度, length(stack) as 堆栈长度
--  --   from frontend_errors order by ts desc limit 1;   -- 期望 500 / 2000
--
--  ④ 限流：连打 21 次之后第 21 次回 `{"ok": false, "reason": "rate-limited"}`
--     —— 钉在 `app/scripts/rls-checks.mjs` 第二·之七节（真 PGlite）。
-- ============================================================


-- ============================================================
--  25. 用户反馈（2026-09-29 管理台第二期 · `feedback`）
--      设计见 `管理台第二期方案.md` §二.5
--
--  🔴🔴 **反馈 ≠ 通知：方向相反，数据模型零复用**（本仓库最容易搞混的第二处）
--
--     · **通知**（`notices` §21）＝ **学校对老师**说话：`sender_id` 是一个有身份的账号，
--       收件人是**算出来的范围**，有 `scope_kind` / `pinned` / `revoked_at` / `expires_at`。
--     · **反馈**（本节）＝ **老师对学校**说话：`author_id` 是任何一位在册教师，
--       「收件人」就是**一个人 / 一个邮箱**，没有范围、没有已读、没有置顶。
--     ⛔ 反馈表里**不许**出现 `scope_kind` / `pinned` / `revoked_at` / `expires_at`；
--     ⛔ 通知表里**不许**出现 `handled_at` / `mail_state` / `contact`。
--     ⚠️ 界面上的实招：两条通道的**入口位置分开**（通知在导航 + 工作台；
--        反馈在「我的」页最下面），且反馈块上明写一句「只给管理员看，不会出现在通知里」。
--
--  🔴 **先落库、再发信**（本件的验收核心）：插入成功就**立刻**算"已送到"，
--     发信失败**不回滚、也不改用户看到的结果** —— 反过来（只发信不存库）会让
--     邮件一失败那条反馈**永久消失**，而双方都以为送到了。
--     数据库里 `mail_state` / `mail_error` 就是那条留痕；
--     `/admin` 的反馈卡上必须**显式报警**（`mail_state <> 'sent'` 的条数）。
--
--  🔴 **读**：这张表**一条策略都不建**、连 SELECT 都不给 —— 因为"内部字段不能给作者看"
--     这件事 **RLS 表达不了**（RLS 管行，不管列）。所以：
--       · 作者看自己那几条 → `POST /api/feedback {action:'mine'}`（按 JWT 过滤 + 剥字段）；
--       · 超管看全部     → `POST /api/feedback {action:'admin-list'}`。
--     两条都走同一个 Function（service_role），**判据在数据库**。
--
--  ⚠️ **不做附件**（方案 §二.5 的三条理由）：硬挂 `shared_files` 会出现
--     "老师传给管理员的截图，教室里那块屏也看得见"。
--
--  ⚠️ 本段可重复执行（幂等）。
-- ============================================================

-- -------- 25.1 建表 --------
create table if not exists feedback (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid references schools (id) on delete set null,
  -- 谁提的。⚠️ 本项目**不允许匿名提交**（用户 2026-09-28 拍板：未登录 / 前端问题
  -- 一律走前端错误上报那条路）。所以它是 `not null` —— 这张表里不会有"幽灵反馈"。
  author_id     uuid not null references teachers (id) on delete cascade,
  -- 名字 / 身份标签的**快照**（提交时那一刻的，便于人不在了也读得懂）
  author_name   text not null default '',   -- left(…,60)
  author_roles  text not null default '',   -- left(…,120)
  -- 正文（服务端 left(…,1000)）。**< 5 字直接拒**（不是静默截断）
  body          text not null default '',
  -- 选填联系方式，left(…,120)
  contact       text not null default '',
  -- 自动附带的现场（**不带任何学生数据**：不带当前班级、不带名单）
  page          text not null default '',   -- left(…,120)
  env           text not null default '',   -- left(…,20) 'remote' | 'local'
  ua            text not null default '',   -- left(…,300)
  -- ---- 邮件那一半：**必须落库**（邮件会失败，存库才有留底）----
  --   pending 刚插入、还没试发
  --   sent    发出去了（Resend 回了 id）
  --   failed  试了但失败（原因在 mail_error）
  --   skipped 没配 key / 正文疑似含学生信息（**没试**，原因在 mail_error）
  mail_state    text not null default 'pending'
                check (mail_state in ('pending','sent','failed','skipped')),
  mail_error    text not null default '',   -- left(…,300) **不回给用户**
  mail_at       timestamptz,
  -- ---- 处理状态（给"我提过的"用；**作者只看得到这一列的结论**）----
  handled_at    timestamptz,
  internal_note text not null default '',   -- left(…,300) **内部字段，作者看不到**
  reply         text not null default '',   -- left(…,1000) 可选回复（作者看得到）
  handled_by    uuid references teachers (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists feedback_created_idx on feedback (created_at desc);
-- 「我提过的」是作者维度的热路径
create index if not exists feedback_author_idx on feedback (author_id, created_at desc);
-- 反馈卡的"待处理 / 邮件没发出去"两个计数都要按状态数
create index if not exists feedback_mail_idx on feedback (mail_state);

alter table feedback enable row level security;
-- 🔴 一条策略都不建，连 SELECT 都不给（理由见文件头：RLS 管不了列）
revoke all on feedback from anon, authenticated;

-- -------- 25.2 判据：**这位在册教师能不能给管理员发消息** --------
--  🔴 判据一律走 `_for` / 裸版**两件套**（与 §21.4 / §22.2 同一套）：
--     `_for` 接受任意 uid（= "以任意人身份问一句"）→ **一律 revoke**，只留给属主核对；
--     裸版 grant 给 authenticated，服务端拿**调用者自己的 JWT** 走 RPC 问它。
--
--  ⚠️ 语义刻意**不叫** `can_send_feedback`：它守的不只是反馈这一条路 ——
--     `POST /api/mail` 的 `backup` 那一支（备份完成通知）用的是**同一个条件**
--     （"在册教师、不是教室端"）。**一个判据一种语义**，两条路共用它，
--     所以名字说的是那件共同的事（"能不能给管理员发消息"）。
--
--  两半判据（与 `can_publish_announcement_for` 逐字同款）：
--    ① `teachers` 里有一行 —— 挡住"认不出的 uid"（service_role 那条路不能凭幽灵 id 写库）；
--    ② **不是教室端** —— 教室里那块屏没有「我的」页，也没有"给学校提意见"这个身份。
create or replace function public.can_contact_admin_for(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from teachers t where t.id = p_uid)
     and not exists (select 1 from classroom_accounts ca where ca.id = p_uid);
$$;

revoke all on function can_contact_admin_for(uuid) from public, anon, authenticated;

create or replace function public.can_contact_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select can_contact_admin_for(auth.uid()) $$;

grant execute on function can_contact_admin() to authenticated;

-- -------- 25.3 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 表上 0 条策略、连 SELECT 都没给：
--  -- select policyname from pg_policies where tablename = 'feedback';   -- 期望 0 行
--  -- select has_table_privilege('authenticated','feedback','select');    -- 期望 false
--
--  ② 判据（把 uuid 换成要核对的老师 id）：
--  -- select public.can_contact_admin_for('00000000-0000-0000-0000-000000000000'::uuid);
--  -- 期望：任课教师 true；**教室端 false**；认不出的 uuid false
--
--  ③ `mail_state` 的四个值由 check 钉死，塞第五个值必须报错：
--  -- update feedback set mail_state = 'nonsense';   -- 期望 23514 check 违反
--
--  ④ **先落库再发信**（发信失败时库里仍有行）：钉在
--     `app/scripts/admin-checks.mjs`（假 Supabase + 真 Function）——
--     SQL 编辑器里跑不了（那里没有 Resend 的两条分支）。
-- ============================================================


-- ============================================================
--  26. 运维只读报告：**数据库用量**（2026-09-29 管理台第二期）
--      设计见 `管理台第二期方案.md` §二.2 · 落地口径见 `功能设计与不变量.md` §二十五
--
--  🔴 **为什么必须是一个函数**：`pg_database_size()` / `pg_total_relation_size()`
--     都是**目录表上的函数**，PostgREST 的表端点上拿不到（anon key 连权限都没有，
--     而且前端不该有）。所以照本仓库一贯的做法：**服务端拿 service_role 调它**，
--     前端永远看不到原生的字节数来源。
--
--  🔴 **它只回答"字节数与计数"，绝不回任何行内容**（`question_meta` 那一列
--     里是**题图的 base64**：只报**体积**，绝不显示图片 —— 与第一期 J2 同一条纪律）。
--     排行里给的是「班级名 + 档案 id + 字节数」，**没有学生、没有题目、没有成绩**。
--
--  ⚠️ **配额（1 GB）与阈值不在这里**：它们在 `app/src/lib/adminChart.ts`
--     （`DB_QUOTA_BYTES` / `DB_WARN_PCT` / `DB_BAD_PCT`）。
--     **一个常量只能有一处** —— 这个函数只量数，不判色。
--
--  ⚠️ 行数是 `pg_class.reltuples`，那是**规划器的估算**，不是精确值：
--     还没被 ANALYZE 过的表回 -1 → 这里归一成 **null（= 无法判断）**，
--     ⚠️ **绝不归一成 0**（"0 行"与"还没统计过"是两件事，本项目最贵的一条教训）。
--
--  ⚠️ 本段可重复执行（幂等）。
-- ============================================================

create or replace function public.db_usage_report()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with t as (
    select c.relname::text as name,
           pg_total_relation_size(c.oid) as bytes,
           c.reltuples::bigint as rows_estimate
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'm')
  ),
  a as (
    select x.id::text as assignment_id,
           coalesce(cl.name, '') as class_name,
           octet_length(x.question_meta::text) as bytes
      from assignments x
      left join classes cl on cl.id = x.class_id
  )
  select jsonb_build_object(
    'totalBytes', pg_database_size(current_database()),
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', t.name,
               'bytes', t.bytes,
               'rowsEstimate', case when t.rows_estimate < 0 then null else t.rows_estimate end)
             order by t.bytes desc)
        from (select * from t order by bytes desc limit 12) t
    ), '[]'::jsonb),
    'questionMetaBytes', coalesce((select sum(octet_length(question_meta::text))::bigint from assignments), 0),
    'archives', coalesce((
      select jsonb_agg(jsonb_build_object(
               'assignmentId', a.assignment_id,
               'className', a.class_name,
               'bytes', a.bytes)
             order by a.bytes desc)
        from (select * from a order by bytes desc limit 10) a
    ), '[]'::jsonb)
  );
$$;

-- 🔴 只有服务端（service_role）能调它：给 anon / authenticated 就等于
--    把整库的字节数（含逐表排行）摊给任何人 —— 面板的数据**只走服务端**。
revoke all on function db_usage_report() from public, anon, authenticated;

-- -------- 26.1 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 匿名 / 登录用户都调不动（两条都必须报 42501 权限不足）：
--  -- select public.db_usage_report();     -- 以 anon 身份
--
--  ② 形状（以属主身份跑，看四个键在不在）：
--  -- select jsonb_object_keys(public.db_usage_report());
--  -- 期望：totalBytes / tables / questionMetaBytes / archives
--
--  ③ ⚠️ **这个函数只量数，不判色**（配额与阈值在 `adminChart.ts`）：
--  -- select public.db_usage_report() -> 'totalBytes';   -- 是个数字，不是颜色
-- ============================================================


-- ============================================================
--  27. 开学准备（P6，2026-09-30）
--      「名单 → 建班 → 班型 → 选科 → 身份」那一条流水线要的列、表、判据与写入口
-- ------------------------------------------------------------
--  ⚠️ **本段是 P6 自己带进来的最小前置**，与 `选科走班实施计划.md` 的分期对不上，
--     原样记在这里，不给它编一个"P3/P5 已完成"的说法：
--    · P3 的「年级生命周期」**整期没做** —— 本段只补 `grades` 的三列（届 / 学段 / 入学日期）
--      与那条按 (school_id, cohort) 的唯一索引；`academic_years` / `terms` /
--      提档 / 毕业删除**一行都没有**。
--    · P5 的「统一模型改造」**整期没做** —— 本段只补 `classes.kind` / `class_type` /
--      `stream_key` 三列。`assignments.class_id` 允许为空、以及那些 `classId`
--      过滤点**一个字都没动**（今天库里没有任何 `kind='stream'` 的行，所以那些漏点
--      暂时漏不出数据；**建走班班之前必须先做 P5**）。
--      ✅ **2026-10-03 的 P5 已经补齐**（见本文件 §31）：`assignments.class_id` 可空 +
--      写判据容纳"未归属" + 全仓 47 处归属判定点逐个过 + 对照法验收。
--    · 本段落地之后，`grades.cohort` 这一段**不影响 P1 的序列号**：§20.3 的
--      `serial_year_of_class()` 原本就用 `to_jsonb(g) ->> 'cohort'` 读它，
--      列一出现就自动优先取它（函数体不用改）。
-- ============================================================

-- -------- 27.1 `grades`：届 / 学段 / 入学日期 --------
--  `cohort` = **届 = 入校年份**，纯 4 位年份（如 `2025`）。格式写死成 4 位数字，
--  因为 P1 的序列号就是"届 + 3 位序号"，认不出年份时**不发号**（I14）。
alter table grades add column if not exists cohort      text not null default '';
alter table grades add column if not exists stage       int  not null default 1;
alter table grades add column if not exists enrolled_at date;

--  `cohort` 的格式约束：空串（还没填）或 4 位数字。**先建新的、再 drop 旧的**那一套
--  在 check 约束上同样适用（幂等：`if not exists` 由 pg_constraint 判）。
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'grades'::regclass and conname = 'grades_cohort_check'
  ) then
    alter table grades add constraint grades_cohort_check
      check (cohort = '' or cohort ~ '^[0-9]{4}$');
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'grades'::regclass and conname = 'grades_stage_check'
  ) then
    alter table grades add constraint grades_stage_check check (stage in (1, 2, 3));
  end if;
end $$;

-- 一个学校一届只有一行（提档不改 id、只改 stage，所以"届"才是稳定标识）。
-- ⚠️ 老的 `grades_school_name_key`（按 name 唯一）**留着不删** —— 删它要确认
--    `ensureGradeLookup()` 那条按名字换 id 的兼容路不再有人走，那是 P3 的活。
--    ⚠️ 但**不要再靠它**：两个年级的 `name` 相同（都是"高一"）时它才是拦路的那一条。
create unique index if not exists grades_school_cohort_key on grades (school_id, cohort)
  where cohort <> '';

-- ✅ 回填（只填能确证的三个届，**绝不覆盖已有值**；Q18 给过：高二 = 2025 / 高一 = 2026 / 高三 = 2024）
update grades set cohort = '2026' where cohort = '' and name = '高一';
update grades set cohort = '2025' where cohort = '' and name = '高二';
update grades set cohort = '2024' where cohort = '' and name = '高三';
update grades set stage  = 1      where name = '高一' and stage is distinct from 1;
update grades set stage  = 2      where name = '高二' and stage is distinct from 2;
update grades set stage  = 3      where name = '高三' and stage is distinct from 3;

-- -------- 27.2 `classes`：两种班同一张表（`kind`）+ 班型（`class_type`）+ 组合标识 --------
--  ⚠️ `kind` 的默认值**必须是 `'admin'`**：老的 `classToRow` 不送这一列，
--     默认值让**老代码的行为一个字节不变**（前端 `saveClass` 现在会显式带上它）。
alter table classes add column if not exists kind        text not null default 'admin';
alter table classes add column if not exists class_type  text not null default '';
alter table classes add column if not exists stream_key  text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'classes'::regclass and conname = 'classes_kind_check'
  ) then
    alter table classes add constraint classes_kind_check check (kind in ('admin', 'stream'));
  end if;
  /*
   * `class_type` 的四档（一个字段只能有一种语义，所以四档的含义写死）：
   *   ''          还没设置        ← 默认，**不许默认成理科班**（猜错 = 全班的默认选科都错）
   *   'undivided' 未分科          ← Q3 = B 显式加的那一档，与"还没设置"是**两件事**
   *   'arts'      文科班（默认 历史 + 政治 + 地理；**首选必须是历史**）
   *   'science'   理科班（默认 物理 + 化学 + 生物；**首选必须是物理**）
   */
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'classes'::regclass and conname = 'classes_class_type_check'
  ) then
    alter table classes add constraint classes_class_type_check
      check (class_type in ('', 'undivided', 'arts', 'science'));
  end if;
end $$;

-- -------- 27.3 `student_subjects`：首选 1 + 再选 2（+「其他」） --------
--  🔴 **不枚举 12 种组合**（Q1 = C）：约束写成"首选 1 门 + 再选 2 门"的**结构约束**，
--     「学校开不出的组合」走 `kind = 'other'` + `note`（原因必须填）。
create table if not exists student_subjects (
  student_id  uuid primary key references students (id) on delete cascade,
  primary_code text not null default '',
  second_codes text[] not null default '{}',
  kind        text not null default 'standard',
  note        text not null default '',
  updated_by  uuid references teachers (id),
  updated_at  timestamptz not null default now()
);
create index if not exists student_subjects_kind_idx on student_subjects (kind);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'student_subjects'::regclass and conname = 'student_subjects_kind_check'
  ) then
    alter table student_subjects add constraint student_subjects_kind_check
      check (kind in ('standard', 'other'));
  end if;
end $$;

-- -------- 27.4 🔴 **选科的唯一校验入口**（I16 / I48：四条写入路径共用它）--------
--  四条写入路径 = ① 单条改 ② 粘贴批量 ③ 一键按班型默认 ④ 导入。
--  它们**都必须**问这一个函数，谁都不许在自己那边再写一遍结构判断。
--
--  判据（三条，逐条都能单独报出人话）：
--    ① `kind = 'other'` → **必须**手工选走班科目（再选那 2 门一个都不能空），
--       而且 `note`（原因）必须填 —— "其他"不是"忘了填"的占位。
--    ② `kind = 'standard'` → 首选必须是**物理或历史**（3+1+2 里的那个"1"），
--       再选恰好 2 门、且只能从**化学 / 生物 / 政治 / 地理**里取，两门不许相同。
--    ③ 首选**不许**出现在再选里（物理 + 物理/化学 这种）。
--
--  ⚠️ 12 种合法组合是上面三条的**推论**，不是另一份清单 ——
--     写死一份 12 项的清单就成了"同一件事两个判定入口"（§十 踩过四次）。
create or replace function public.student_subject_check(
  p_kind text,
  p_primary text,
  p_second text[],
  p_note text
) returns void
language plpgsql
immutable
as $$
declare
  v_second text[] := coalesce(p_second, '{}');
begin
  if p_kind not in ('standard', 'other') then
    raise exception '选科类型只认 standard / other，收到的是 %', p_kind;
  end if;

  if p_kind = 'other' then
    if coalesce(array_length(v_second, 1), 0) = 0 then
      raise exception '「其他」的学生必须手工选走班科目（再选两门不能空）';
    end if;
    if array_length(v_second, 1) <> 2 then
      raise exception '再选科目必须恰好 2 门，这一行有 % 门', array_length(v_second, 1);
    end if;
    if coalesce(btrim(p_note), '') = '' then
      raise exception '「其他」必须填原因';
    end if;
    return;
  end if;

  if p_primary not in ('physics', 'history') then
    raise exception '首选只能是物理或历史，收到的是 %', coalesce(nullif(p_primary, ''), '（空）');
  end if;

  if coalesce(array_length(v_second, 1), 0) <> 2 then
    raise exception '再选科目必须恰好 2 门，这一行有 % 门', coalesce(array_length(v_second, 1), 0);
  end if;

  if exists (
    select 1 from unnest(v_second) s
     where s not in ('chemistry', 'biology', 'politics', 'geography')
  ) then
    raise exception '再选只能从 化学 / 生物 / 政治 / 地理 里取，这一行是：%', array_to_string(v_second, '、');
  end if;

  if v_second[1] = v_second[2] then
    raise exception '再选两门不许相同：%', v_second[1];
  end if;

  if p_primary = any (v_second) then
    raise exception '首选 % 不许出现在再选里', p_primary;
  end if;
end $$;

-- -------- 27.5 `class_members`：走班班成员（**多对多，不能省**）--------
--  ⚠️ 本期**只建表**：成员由 P7 的"生成走班班"与本期「其他」学生的手工选班写入。
--     一个学生同时在 2 个走班班里是常态（差 2 门），所以主键是 (class_id, student_id)。
create table if not exists class_members (
  class_id   uuid not null references classes (id) on delete cascade,
  student_id uuid not null references students (id) on delete cascade,
  primary key (class_id, student_id)
);
create index if not exists class_members_student_idx on class_members (student_id);

-- -------- 27.5b 🔑 `class_subjects` 的 unique 换列（P7 的破坏性迁移**提前到这里**）--------
--  为什么要提前：本段的 `bulk_write_class_subjects()` 要用
--  `on conflict (class_id, subject_code, teacher_id)`，而**冲突目标必须有一条唯一索引兜着**——
--  老的 unique 是 `(class_id, subject, teacher_id)`，`on conflict` 拿它匹配不上，
--  PostgREST 会回 `42P10`（"no unique or exclusion constraint matching the ON CONFLICT"）。
--
--  顺序纪律（照 §16.3「先补新的、再删旧的」）：
--   · **只建新的，老的 `class_subjects_class_id_subject_teacher_id_key` 留着不删。**
--     新索引的列集是老的**超集**（subject_code 与 subject 一一对应、都非空）→
--     新的比老的严，留着老的**不会放进任何一行脏数据**；
--     而 `drop constraint` 要单独确认没有代码依赖它 —— 那是 P7 的活，不是这一段的。
--   · ⚠️ 建索引前先确认没有重复（有重复时 `create unique index` 会直接失败、整份脚本回滚）。
--     查重 SQL 见 §27.12 第 ⑤ 条。
create unique index if not exists class_subjects_unique_code
  on class_subjects (class_id, subject_code, teacher_id);

-- -------- 27.6 🆕 年级主任：**一个年级只允许一个**（Q25 = B）--------
--  🔴 **建索引之前必须先清洗历史数据**：库里若已有同年级多行 `grade_head`，
--     `create unique index` 会直接失败，而失败发生在整份 `schema.sql` 里 →
--     整段回滚（不会留下半截状态，但用户会看到"跑不过去"）。
--  清洗口径（**只在这一种情况下动手**）：同一个年级的多个年级主任里，
--  **留最早的那一行**、删掉其余的 —— 删掉的条数与原因由下面的 `raise notice` 报出来，
--  绝不静默。要保留别人，就先手工把该行改成正确的年级再跑本段。
do $$
declare
  v_dropped int := 0;
begin
  with ranked as (
    select r.id,
           row_number() over (
             partition by r.scope_id
             order by r.created_at, r.id
           ) as rn
      from teacher_roles r
     where r.role = 'grade_head' and r.scope_type = 'grade' and r.scope_id is not null
  )
  delete from teacher_roles t
   using ranked k
   where t.id = k.id and k.rn > 1;
  get diagnostics v_dropped = row_count;
  if v_dropped > 0 then
    raise notice '一个年级只允许一个年级主任：清洗掉 % 行重复的 grade_head（留最早的那一行）', v_dropped;
  end if;
end $$;

create unique index if not exists teacher_roles_one_grade_head
  on teacher_roles (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where role = 'grade_head' and scope_type = 'grade';

-- -------- 27.7 判据（**定义在引用它的策略之前** —— `create policy` 会当场解析函数名）--------

--  这个年级的开学准备（录名单 / 建班 / 设班型 / 采选科）归谁管：
--  **最高管理员 · 教务处 · 本年级的年级主任**。
--  ⚠️ 班主任**不在**这一档（他能改本班学生的选科，但设不了班型、建不了班）。
--
--  🔴 **2026-10-02（集成修复）：本条与下面两条判据一律拆成 `_for` / 裸版两件套**（I33），
--     与 §13.2 / §16.2 / §21.4 / §29.2 同一个形状。理由见本节末尾
--     「27.13 服务端调写入口的正确形状」：三个写入口必须由服务端用 **service_role + 显式 `p_actor`**
--     调（它们的 `revoke … from authenticated` 不能撤 —— 见 §27.12），
--     而 `service_role` 下 `auth.uid()` 是 **NULL** —— 判据必须能接受"显式传进来的人"。
--  ⚠️ `_for` 变体接受任意 uid，等于"以任意人身份问权限" → 一律 revoke（见 §27.12）。
create or replace function public.can_manage_grade_setup_for(p_uid uuid, p_grade_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_school_admin_for(p_uid)
      or exists (
           select 1 from teacher_roles r
            where r.teacher_id = p_uid
              and r.role = 'grade_head'
              and r.scope_type = 'grade'
              and r.scope_id = p_grade_id
         );
$$;

-- 当前登录者版本（前端读它决定摆不摆入口；写入口一律用 `_for` 那一份 + 显式人）
create or replace function public.can_manage_grade_setup(p_grade_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.can_manage_grade_setup_for(auth.uid(), p_grade_id) $$;

--  这个学生的选科归谁改：**最高管理员 · 教务处 · 本年级的年级主任 · 本班班主任**。
--  ⚠️ 与 `can_manage_grade_setup` 的差别只有"班主任"这一档 —— 两条判据分开写，
--     因为"能改一个学生的选科"与"能设定整个年级的班型"是**两种权限**。
--  🔴 同样拆两件套（理由见 `can_manage_grade_setup_for` 上面那段与 §27.13）。
create or replace function public.can_edit_student_subject_for(p_uid uuid, p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_school_admin_for(p_uid)
      or exists (
           select 1
             from students s
             join classes c on c.id = s.class_id
            where s.id = p_student_id
              and (
                   c.id in (select visible_class_ids_for(p_uid))
                or exists (
                     select 1 from teacher_roles r
                      where r.teacher_id = p_uid
                        and r.role = 'grade_head'
                        and r.scope_type = 'grade'
                        and r.scope_id = c.grade_id
                   )
              )
         );
$$;

create or replace function public.can_edit_student_subject(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.can_edit_student_subject_for(auth.uid(), p_student_id) $$;

--  派生判据：这个班的开学准备（班型 / 建班）归谁管 → 直接走它所属年级那条。
create or replace function public.can_manage_class_setup_for(p_uid uuid, p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_manage_grade_setup_for(
           p_uid,
           (select c.grade_id from classes c where c.id = p_class_id)
         );
$$;

create or replace function public.can_manage_class_setup(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.can_manage_class_setup_for(auth.uid(), p_class_id) $$;

-- -------- 27.8 RLS：**读得宽、写得窄** --------
alter table student_subjects enable row level security;
alter table class_members    enable row level security;

--  读：**看得见这个学生所在班**就能读他的选科（"读得宽"；
--      班主任 / 任课老师 / 年级主任 / 教务处都要看名单上的选科）。
drop policy if exists student_subjects_read on student_subjects;
create policy student_subjects_read on student_subjects for select to authenticated
  using (
    exists (
      select 1 from students s
       where s.id = student_subjects.student_id
         and s.class_id in (select visible_class_ids())
    )
  );

--  写：只有 `can_edit_student_subject()` 那一档。
--  🔴 **写策略仍然要给**（哪怕写入永远走服务端）：只给 select 的策略意味着
--     客户端 upsert 会被拒 —— 那不是"静默失败"，是**显式报错**，符合 §三.5 那条纪律。
drop policy if exists student_subjects_write on student_subjects;
create policy student_subjects_write on student_subjects for all to authenticated
  using (public.can_edit_student_subject(student_id))
  with check (public.can_edit_student_subject(student_id));

--  走班班成员：读跟"看得见这个班"走；写**只走服务端**（P7 的生成 + 本期的「其他」手工选班），
--  与 `class_subjects` 同一条纪律 —— 客户端**零写权限**。
drop policy if exists class_members_read on class_members;
create policy class_members_read on class_members for select to authenticated
  using (class_id in (select visible_class_ids()));

revoke all on class_members from anon, authenticated;
grant select on class_members to authenticated;
grant select on student_subjects to authenticated;
revoke all on student_subjects from anon;

-- -------- 27.9 🔑 「其他」学生的手工选班（**与选科写入同一个事务**）--------
--  Q1 = C 的第三条：`kind = 'other'` 的学生**必须手工选走班科目** ——
--  那是"走班班成员"在本期唯一的手工入口，所以它必须和选科那一行**一起**成功或一起失败。
--
--  🔴 为什么写成一个函数、而不是让服务端先写选科再写成员：
--     两次 PostgREST 请求 = 两个事务 = **可以只成功一半**，
--     而那正是本期验收要钉死的那条（"改一半的情况不发生"）。
--     PostgREST 一次 RPC = 一个事务，所以这里必须是一句 SQL 函数。
--
--  🔴 **2026-10-02（集成修复）：第一个参数是 `p_actor`**（照 §29.4 `promote_grades(p_actor)`
--     的形状）。本函数 `revoke … from authenticated`（§27.12）不能撤 ——
--     PostgREST 以 `authenticated` 角色执行，而 `service_role` 下 `auth.uid()` 是 **NULL**
--     （那是属主身份），所以"谁干的"必须**显式传进来**；
--     判据由 `can_edit_student_subject_for(p_actor, …)` 自己问数据库，服务端一个判据都不写。
--     完整理由与"为什么不能改成 grant execute … to authenticated"见 §27.13。
--
--  ⚠️ **先 drop 旧签名、再建新的**（§21.3.2 的先例）：这三个函数在线上已经存在，
--     而 `create or replace` **改不了签名**（那是重载）—— 留着旧签名 =
--     同一个动作有两个入口、"少传一个 `p_actor` 也能过权限那道门"（判据会拿到 NULL）。
drop function if exists public.write_student_subject(uuid, text, text, text[], text, uuid[]);
create or replace function public.write_student_subject(
  p_actor uuid,
  p_student_id uuid,
  p_kind text,
  p_primary text,
  p_second text[],
  p_note text,
  p_member_class_ids uuid[] default '{}'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_grade uuid;
  v_class        uuid;
  v_class_grade  uuid;
  v_members      uuid[];
begin
  if not public.can_edit_student_subject_for(p_actor, p_student_id) then
    raise exception '你没有改这个学生选科的权限';
  end if;

  perform public.student_subject_check(p_kind, p_primary, p_second, p_note);

  select c.grade_id into v_target_grade
    from students s join classes c on c.id = s.class_id
   where s.id = p_student_id;
  if v_target_grade is null then
    raise exception '这个学生没有挂到任何年级上，先把它挂到班与年级上再采选科';
  end if;

  insert into student_subjects (student_id, primary_code, second_codes, kind, note, updated_by, updated_at)
  values (p_student_id, coalesce(p_primary, ''), coalesce(p_second, '{}'), p_kind,
          coalesce(p_note, ''), p_actor, now())
  on conflict (student_id) do update
     set primary_code = excluded.primary_code,
         second_codes = excluded.second_codes,
         kind         = excluded.kind,
         note         = excluded.note,
         updated_by   = excluded.updated_by,
         updated_at   = now();

  /* 手工选班只对「其他」开放：标准组合的走班班由 P7 生成，不许在这里插队 */
  if p_kind = 'other' then
    if coalesce(array_length(p_member_class_ids, 1), 0) = 0 then
      raise exception '「其他」的学生必须手工选走班科目（走班班一个都没选）';
    end if;
    foreach v_class in array p_member_class_ids loop
      select c.grade_id into v_class_grade from classes c where c.id = v_class;
      if v_class_grade is null then
        raise exception '选中的走班班不存在或没有年级（%）', v_class;
      end if;
      if v_class_grade <> v_target_grade then
        raise exception '走班班必须和学生在同一个年级里（这个班属另一个年级）';
      end if;
      if not exists (select 1 from classes c where c.id = v_class and c.kind = 'stream') then
        raise exception '只能选走班班（kind = stream），% 不是走班班', v_class;
      end if;
    end loop;
    select coalesce(array_agg(distinct x), '{}') into v_members
      from unnest(p_member_class_ids) x;
    delete from class_members where student_id = p_student_id;
    insert into class_members (class_id, student_id)
    select m, p_student_id from unnest(v_members) m
    on conflict do nothing;
  else
    if coalesce(array_length(p_member_class_ids, 1), 0) > 0 then
      raise exception '标准组合的走班班由系统生成（P7），手工选班只对「其他」开放';
    end if;
  end if;

  return jsonb_build_object('ok', true, 'studentId', p_student_id);
end $$;

-- -------- 27.10 🔑 批量写任教关系（**一个事务**）--------
--  `class_subjects` 在数据库层**零写权限**（§27.8 同款纪律），所以它只能走
--  **service_role 的服务端 Function**；那个 Function 用 **service_role + 显式 `p_actor`**
--  调本函数，判据由 `can_manage_grade_setup_for(p_actor, …)` 自己问数据库（见 §27.13）。
--
--  🔴 一个 RPC = 一个事务：**要么全成、要么全不成**（本期验收的那条断言）。
--  🔴 顺序纪律：**先解析、再逐行校验、最后才写** —— 任何一行非法都还没碰过一张表。
--
--  入参形状（服务端已经做过形状校验；这里只信类型、不信内容）：
--    · `p_actor`：**谁在写**（服务端从调用者 JWT 里验出来的那个 id）
--    · `p_rows`：[{ "class_id": "<uuid>", "subject_code": "physics", "teacher_id": "<uuid>" }, …]
drop function if exists public.bulk_write_class_subjects(jsonb);
create or replace function public.bulk_write_class_subjects(p_actor uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_g        uuid;
  v_n        int := 0;
  v_deleted  int := 0;
  v_grades   uuid[] := '{}';
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '要写的是"一数组的任课关系"，收到的不是数组';
  end if;

  /*
   * 🔴 **上限与空表先判**（在逐行校验之前）：3001 行的那份表会被"第 1 行的班级不存在"
   *    截住，用户看到的是一句与真正原因无关的话（与 `bulk_import_roster()` 同款）。
   */
  if jsonb_array_length(p_rows) = 0 then
    raise exception '一行都没有 —— 这份表是空的';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception '一次最多写 2000 行，这次有 % 行 —— 分两批', jsonb_array_length(p_rows);
  end if;

  /* ① 遍历校验（这一圈里**一行都不写**） */
  for r in
    select (e ->> 'class_id')::uuid     as class_id,
           btrim(e ->> 'subject_code')  as subject_code,
           (e ->> 'teacher_id')::uuid   as teacher_id
      from jsonb_array_elements(p_rows) e
  loop
    v_n := v_n + 1;
    if r.class_id is null or r.teacher_id is null or coalesce(r.subject_code, '') = '' then
      raise exception '第 % 行缺字段（班级 / 学科 / 老师三样都要）', v_n;
    end if;
    if not exists (select 1 from classes c where c.id = r.class_id) then
      raise exception '第 % 行的班级不存在', v_n;
    end if;
    if not exists (select 1 from teachers t where t.id = r.teacher_id) then
      raise exception '第 % 行的老师不存在', v_n;
    end if;
    if not exists (select 1 from subjects s where s.code = r.subject_code) then
      raise exception '第 % 行的学科认不出（%）', v_n, r.subject_code;
    end if;
    v_grades := v_grades || (select c.grade_id from classes c where c.id = r.class_id);
  end loop;

  /* ② 判据（**每个班各自的年级都问一遍**；全部通过才往下走） */
  for v_g in select distinct g from unnest(v_grades) g where g is not null loop
    if not public.can_manage_grade_setup_for(p_actor, v_g) then
      raise exception '你没有设定这个年级任课关系的权限（年级 %）', v_g;
    end if;
  end loop;

  /*
   * ③ 落地用的暂存表。
   *    🔴 为什么用暂存表而不是 CTE：这一句里要**读同一份数据两次**
   *       （先 delete 掉被替换的老师、再 insert），而 CTE 在多个引用点上会被展开两次，
   *       `jsonb_array_elements(p_rows)` 就会跑两遍。暂存表让"解析"只发生一次。
   *    ⚠️ `on commit drop` + `delete` 让它在同一会话的第二次调用里也是干净的。
   */
  create temp table if not exists _p6_cs (
    class_id     uuid,
    subject_code text,
    teacher_id   uuid
  ) on commit drop;
  delete from _p6_cs;
  insert into _p6_cs (class_id, subject_code, teacher_id)
  select (e ->> 'class_id')::uuid, btrim(e ->> 'subject_code'), (e ->> 'teacher_id')::uuid
    from jsonb_array_elements(p_rows) e;

  /* ④ 一次写完：先删掉"同一个班同一科被别人占着"的老行，再插新的 */
  delete from class_subjects cs
   using _p6_cs t
   where cs.class_id = t.class_id
     and cs.subject_code = t.subject_code
     and cs.teacher_id <> t.teacher_id;
  get diagnostics v_deleted = row_count;

  insert into class_subjects (class_id, subject, teacher_id, subject_code)
  select t.class_id, s.name, t.teacher_id, t.subject_code
    from _p6_cs t
    join subjects s on s.code = t.subject_code
  on conflict (class_id, subject_code, teacher_id) do nothing;

  return jsonb_build_object('ok', true, 'rows', v_n, 'replaced', v_deleted);
end $$;

-- -------- 27.11 🔑 录名单 + 按班号自动建班（**一个事务**）--------
--  教务处在「开学准备」里粘贴一整个年级的名单，服务端把解析好的行交到这里。
--  🔴 **一个 RPC = 一个事务**：几十个班、几百个学生，要么全成、要么一行都不落 ——
--     "导了一半"是这一期最不能接受的失败样子（人工根本对不出少了谁）。
--  🔴 **顺序纪律**：先校验完**每一行**，再碰任何一张表。
--
--  入参形状（服务端的形状校验只保证"是数组"；内容一律在这里判）：
--    · `p_actor`：**谁在导**（服务端从调用者 JWT 里验出来的那个 id）——
--      `service_role` 下 `auth.uid()` 是 NULL，所以它同时承担三件事：
--      判据（`can_manage_grade_setup_for`）/ 新建班的 `teacher_id` / 审计口径（见 §27.13）。
--    · `p_rows`：[{ "class_no": "1", "student_no": "01", "name": "王志远", "serial": "2026001" }, …]
--    · `serial` 留空 → 交给 §20 的 `students_serial_fill()` 触发器**自动发号**
--      （**导入不许自己算号** —— 算号只有那一处）。
--    · `class_no` = 班号，**按它自动建班**（0 步：名单里出现几个班号就建几个班）。
drop function if exists public.bulk_import_roster(uuid, jsonb, text);
create or replace function public.bulk_import_roster(
  p_actor uuid,
  p_grade_id uuid,
  p_rows jsonb,
  p_class_name_template text default '%s'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r               record;
  v_n             int := 0;
  v_grade_name    text;
  v_school_id     uuid;
  v_teacher_id    uuid := p_actor;
  v_class_id      uuid;
  v_class_ids     uuid[] := '{}';
  v_students      int := 0;
  v_serial_missing int := 0;
  v_inc           int := 0;
  v_out           jsonb;
  v_tmpl          text := coalesce(nullif(btrim(p_class_name_template), ''), '%s');
begin
  if p_grade_id is null then
    raise exception '导入名单要指定一个年级';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '要导入的是"一数组的学生行"，收到的不是数组';
  end if;

  select g.name, g.school_id into v_grade_name, v_school_id from grades g where g.id = p_grade_id;
  if v_grade_name is null then
    raise exception '这个年级不存在';
  end if;

  if not public.can_manage_grade_setup_for(p_actor, p_grade_id) then
    raise exception '你没有给这个年级录名单的权限（教务处 / 最高管理员 / 本年级的年级主任）';
  end if;

  /*
   * 🔴 **行数上限先判**（在逐行校验之前）：否则一份 3001 行的名单会先被
   *    "第 N 行的班级不存在"截住 —— 用户看到的是一句与真正原因无关的话。
   *    ⚠️ 与 `bulk_write_class_subjects()` 里那一条同款，两条都写在这个位置。
   */
  if jsonb_array_length(p_rows) = 0 then
    raise exception '一行都没有 —— 这份名单是空的';
  end if;
  if jsonb_array_length(p_rows) > 3000 then
    raise exception '一次最多导入 3000 行，这次有 % 行 —— 按年级分批', jsonb_array_length(p_rows);
  end if;

  /* ① 逐行校验（这一圈里**一行都不写**） */
  for r in
    select btrim(e ->> 'class_no')    as class_no,
           btrim(e ->> 'student_no')  as student_no,
           btrim(e ->> 'name')        as name,
           coalesce(btrim(e ->> 'serial'), '') as serial
      from jsonb_array_elements(p_rows) e
  loop
    v_n := v_n + 1;
    if coalesce(r.name, '') = '' then
      raise exception '第 % 行缺姓名', v_n;
    end if;
    if coalesce(r.class_no, '') = '' then
      raise exception '第 % 行缺班号', v_n;
    end if;
    if length(r.class_no) > 12 then
      raise exception '第 % 行的班号太长（%）', v_n, r.class_no;
    end if;
    if coalesce(r.student_no, '') = '' then
      raise exception '第 % 行缺班级内学号', v_n;
    end if;
    if r.serial <> '' and r.serial !~ '^[0-9]{4}[0-9]{3}$' then
      raise exception '第 % 行的序列号格式不对（%），序列号是"4 位年份 + 3 位序号"', v_n, r.serial;
    end if;
  end loop;

  if v_n > 3000 then
    raise exception '一次最多导入 3000 行，这次有 % 行 —— 按年级分批', v_n;
  end if;

  /* ② 班号 × 班内学号的重复预检（同一个班同一个学号出现两次 = 用户手上的名单有错，
        让数据库报"唯一冲突"不如在这里直接报出"有几组"） */
  select coalesce(sum(n - 1), 0) into v_inc
    from (
      select btrim(e ->> 'class_no') || '|' || btrim(e ->> 'student_no') as k, count(*) as n
        from jsonb_array_elements(p_rows) e
       group by 1
    ) y;
  if v_inc > 0 then
    raise exception '名单里有 % 组"同一个班、同一个班内学号"出现了两次 —— 请先改掉重复的那几行', v_inc;
  end if;

  /* ③ 建班（名单里出现几个班号就建几个；已存在的不重复建） */
  for r in
    select distinct btrim(e ->> 'class_no') as class_no
      from jsonb_array_elements(p_rows) e
  loop
    select c.id into v_class_id
      from classes c
     where c.grade_id = p_grade_id
       and c.name = replace(v_tmpl, '%s', v_grade_name || '(' || r.class_no || ')班')
     limit 1;
    if v_class_id is null then
      select c.id into v_class_id
        from classes c
       where c.grade_id = p_grade_id
         and (c.name = v_grade_name || '(' || r.class_no || ')班' or c.name = r.class_no)
       order by c.created_at
       limit 1;
    end if;
    if v_class_id is null then
      insert into classes (teacher_id, name, grade, school_id, grade_id, kind, class_type)
      values (v_teacher_id,
              replace(v_tmpl, '%s', v_grade_name || '(' || r.class_no || ')班'),
              v_grade_name, v_school_id, p_grade_id, 'admin', '')
      returning id into v_class_id;
    end if;
    v_class_ids := v_class_ids || v_class_id;
  end loop;

  /* ④ 写学生（`serial` 空着交给触发器发号；已有序列号的那一行按"能认出来"处理）
     🔴 班 id **直接从 `classes` join 出来**（不再写一层相关子查询）：
        实测报过 `subquery uses ungrouped column "x.value" from outer query` ——
        把 `jsonb_array_elements` 的列裹进一个 group by 过的派生表之后再引用它，
        PostgreSQL 会拿它当外部引用。join 一遍既更短，也没有这个坑。 */
  insert into students (class_id, student_no, name, serial)
  select c.id,
         btrim(e ->> 'student_no'),
         btrim(e ->> 'name'),
         coalesce(btrim(e ->> 'serial'), '')
    from jsonb_array_elements(p_rows) e
    join classes c
      on c.grade_id = p_grade_id
     and (c.name = v_grade_name || '(' || btrim(e ->> 'class_no') || ')班'
          or c.name = btrim(e ->> 'class_no'))
  on conflict (class_id, student_no) do update
     set name = excluded.name,
         -- 序列号**只补空**：已有序列号的行一个字节都不动（它永久不可改，§20.2 的触发器也拒）
         serial = case when students.serial = '' then excluded.serial else students.serial end;
  get diagnostics v_students = row_count;

  select count(*) into v_serial_missing
    from jsonb_array_elements(p_rows) e
    join students s
      on s.class_id = any (v_class_ids)
     and s.student_no = btrim(e ->> 'student_no')
   where s.serial = '';
  /* 认不出入校年份时触发器**不发号也不报错**（I14）——这里把这种人报出来，不静默 */
  if v_serial_missing > 0 then
    raise notice '有 % 个学生没拿到序列号（这一届的入校年份认不出来）', v_serial_missing;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'classId', s.class_id,
           'studentNo', s.student_no,
           'name', s.name,
           'serial', s.serial
         ) order by s.serial, s.student_no), '[]'::jsonb)
    into v_out
    from students s
   where s.class_id = any (v_class_ids);

  return jsonb_build_object(
    'ok', true,
    'classes', array_length(v_class_ids, 1),
    'students', v_students,
    'noSerial', v_serial_missing,
    'roster', v_out
  );
end $$;

-- -------- 27.12 权限：这三个写函数**只有服务端能调** --------
--  ⚠️ 断言（跑完本段逐条验）：
--    ① 以 authenticated 身份 `select public.write_student_subject(...)` → **42501**
--    ② 以 authenticated 身份 `select public.bulk_write_class_subjects('[]')` → **42501**
--    ③ 以 authenticated 身份 `select public.bulk_import_roster(...)` → **42501**
--    ④ 以 service_role 身份调（带显式 `p_actor`）→ 通（或报出差的那一行的人话）
--
--  🔴 **这三条 revoke 不能撤**（2026-10-02 复核，见 §27.13）：
--     `authenticated` 对 `class_subjects` / `class_members` 是**零写权限**的表，
--     而这三个函数是 `security definer`（绕过 RLS）—— grant 出去 =
--     "任何登录者都能凭一个浏览器的 anon key 直接批量写任教关系 / 建班 / 写选科"，
--     并且绕过服务端的形状校验与上限。所以修法只能是**服务端改用 service_role + 显式 `p_actor`**。
revoke all on function public.write_student_subject(uuid, uuid, text, text, text[], text, uuid[])
  from public, anon, authenticated;
revoke all on function public.bulk_write_class_subjects(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.bulk_import_roster(uuid, uuid, jsonb, text)
  from public, anon, authenticated;

--  `_for` 变体一律 revoke（接受任意 uid = "以任意人身份问权限"；只留给属主核对 / 服务端经 RPC 调）
revoke all on function public.can_manage_grade_setup_for(uuid, uuid) from public, anon, authenticated;
revoke all on function public.can_edit_student_subject_for(uuid, uuid) from public, anon, authenticated;
revoke all on function public.can_manage_class_setup_for(uuid, uuid) from public, anon, authenticated;

--  裸版（读 `auth.uid()`）给 authenticated：`canSetup` 与 `can_edit_student_subject` 的 RLS 策略用它
grant execute on function public.can_manage_grade_setup(uuid) to authenticated;
grant execute on function public.can_manage_class_setup(uuid) to authenticated;
revoke all on function public.can_manage_grade_setup(uuid) from anon;
revoke all on function public.can_manage_class_setup(uuid) from anon;

-- -------- 27.13 🔴 服务端调这三个写入口的**正确形状**（2026-10-02 集成修复）--------
--  事故：`app/functions/api/grade-setup.ts` 拿**调用者 JWT** 去 `POST /rest/v1/rpc/<函数名>`
--  调这三个写函数，而 PostgREST 以 `authenticated` 角色执行 —— 撞上 §27.12 的
--  `revoke … from authenticated` → **线上必 42501**（"录名单 / 批量写任教关系 / 写选科"全线导不进去）。
--  而当时的 `grade-checks`（269 条）全绿：那些断言是**以属主 / 服务角色**跑的 ——
--  "各层各自绿、端到端没人验"。
--
--  ✅ 正确形状（与 §29.4 `promote_grades(p_actor)` **同一套**，全仓一个形状而不是两个）：
--    ① 服务端用 `caller()` 拿调用者 JWT 问 `/auth/v1/user`，验出 `me.id`（**身份只有这一处来源**）；
--    ② 用 **service_role**（属主身份、绕过 RLS）调 `POST /rest/v1/rpc/<函数名>`；
--    ③ **显式传 `p_actor: me.id`** —— `service_role` 下 `auth.uid()` 是 **NULL**，
--       "谁干的"数据库自己问不出来；
--    ④ 判据**仍然只有数据库一处**：函数体里问 `*_for(p_actor, …)`；服务端一个判据都不写
--       （前端只决定摆不摆入口）。
--    ⑤ `bulk_import_roster` 里新建班的 `teacher_id` 也用 `p_actor`（原来是 `auth.uid()`，
--       在 service_role 下会是 NULL → 建出没有班主任的班）。
--
--  ⛔ **为什么不改成 `grant execute … to authenticated`**（看起来只改一行）：
--    · 三个函数**自己确实有判据**（`can_manage_grade_setup_for` / `can_edit_student_subject_for`），
--      所以 grant 之后不会变成"谁都能写" —— 但那是**碰巧**安全，不是设计上安全：
--      它们是 `security definer`，而 `authenticated` 对 `class_subjects` / `class_members`
--      是零写权限的表（§27.8）—— 一旦哪天函数体里少一句判断，grant 就是**直接开一个绕过 RLS 的写口**；
--    · 谁也**绕不过服务端那一层**：形状校验、3000 / 2000 行上限、人话错误码都在那儿；
--      grant 之后浏览器可以拿 anon key 直接打 RPC，同一件事就有**两个入口**（本项目最贵的一类坑）；
--    · §29 已经确立了"service_role + 显式人"这一个形状（§29 的文件头逐字写了为什么不照 §27 那样做）——
--      两种形状并存，下一个写入口的作者必然选错。
-- ============================================================

-- -------- 27.12 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 三个届回填到位：
--  -- select name, cohort, stage from grades order by stage;
--  -- 期望：高一 2026 1 / 高二 2025 2 / 高三 2024 3
--
--  ② 选科校验函数的**正反对照**（三条都要报错，报的必须是上面那几句人话）：
--  -- select public.student_subject_check('standard', 'physics', '{chemistry}', '');          -- 再选只有 1 门 → 报错
--  -- select public.student_subject_check('standard', 'physics', '{chemistry,physics}', ''); -- 首选混进再选 → 报错
--  -- select public.student_subject_check('other',    'physics', '{}', '转学待定');            -- 其他没手工选科 → 报错
--  -- select public.student_subject_check('standard', 'physics', '{chemistry,biology}', ''); -- ✅ 不报错
--
--  ③ 一个年级一个年级主任（唯一索引在不在）：
--  -- select indexname from pg_indexes where tablename='teacher_roles' and indexname='teacher_roles_one_grade_head';
--
--  ④ 写入口只有服务端能调（三条都要 42501）：
--  -- select public.write_student_subject('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','standard','physics','{chemistry,biology}','', '{}');
--  -- select public.bulk_write_class_subjects('00000000-0000-0000-0000-000000000000','[]'::jsonb);
--  -- select public.bulk_import_roster('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','[]'::jsonb);
--  -- 以及 `_for` 那三个（接受任意 uid，同样不许 authenticated 调）：
--  -- select public.can_manage_grade_setup_for('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000');
--
--  ⑤ `class_subjects` 换 unique 之前**必须先跑这一条**（有重复时建索引会失败）：
--  -- select class_id, subject_code, teacher_id, count(*) from class_subjects
--  --  group by 1,2,3 having count(*) > 1;
--  -- 期望：0 行。非 0 就先人工合并那几行（多半是同一个老师在同一班同一科写了两遍）
--  -- 建完之后两条索引都在（新的是老的超集，旧的留到 P7 再单独 drop）：
--  -- select indexname from pg_indexes where tablename='class_subjects';
--
--  ⑥ 批量函数的人话错误码（每一条都要报出"第几行 + 为什么"）：
--  -- select public.bulk_write_class_subjects('00000000-0000-0000-0000-000000000000','[{"class_id":"00000000-0000-0000-0000-000000000000","subject_code":"physics","teacher_id":"00000000-0000-0000-0000-000000000000"}]'::jsonb);
--  -- 期望：报「第 1 行的班级不存在」
-- ============================================================

-- ============================================================
--  28. 学年 / 学期 / 届（P3）+ 存量回填（P2），2026-09-30
--      「年级的稳定标识是届 · 学期是一等实体 · 档案默认只看本学期」
-- ------------------------------------------------------------
--  与 §27（P6）的分工：§27 已经落了 `grades.cohort` / `stage` / `enrolled_at`
--  与三个写函数；**本段不重复定义它们**，只做 §27 明确留给 P3 的四件事：
--    ① `academic_years` + `terms`（教导处设上下半期的起止）
--    ② `assignments.term_id` / `exams.term_id`（期末归档的归属）
--    ③ `exams.grade_id`（Q33：考试按**届**归属，`grade` 文本降级为显示名）
--    ④ `grades` 的唯一键从 `(school_id, name)` 换成 `(school_id, cohort)`
--  以及这一期的**重点**：P2 的存量回填 —— 见末尾的
--  `public.p3_backfill_terms_and_cohorts()`（幂等，重跑受影响行数 = 0）。
--
--  🔴 三个不能破的口径：
--    · **届（cohort）= 纯 4 位入校年份**（`2025`）。高一 = 2026 / 高二 = 2025 / 高三 = 2024。
--    · **提档只改 `stage`，年级 id 不变** —— 所以班级 / 走班班 / 课表的 `grade_id`
--      一个字都不用改（这是"届才是稳定标识"的全部意义）。
--    · **"当前学期"不落一列**（不存 `is_current`）：按**北京时间**推。
--      时间口径一律 `(now() at time zone 'Asia/Shanghai')::date` ——
--      与前端 `beijingNow()` 同源，别用 `current_date`（那是数据库时区，不是北京时间）。
-- ============================================================

-- -------- 28.1 学年与学期 --------
-- `name` = 「2026-2027」；`half` = 1 上半期 / 2 下半期（一个学年恰好两个）。
create table if not exists academic_years (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references schools (id) on delete cascade,
  name       text not null,
  start_date date not null,
  end_date   date not null,
  created_at timestamptz not null default now()
);
-- 一所学校一个学年名只有一行（幂等靠它）
create unique index if not exists academic_years_school_name_key
  on academic_years (school_id, name);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'academic_years'::regclass and conname = 'academic_years_range_check'
  ) then
    alter table academic_years add constraint academic_years_range_check
      check (end_date >= start_date);
  end if;
end $$;

create table if not exists terms (
  id               uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references academic_years (id) on delete cascade,
  half             int  not null,
  start_date       date not null,
  end_date         date not null,
  created_at       timestamptz not null default now()
);
-- 一个学年上下半期各一行
create unique index if not exists terms_year_half_key on terms (academic_year_id, half);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'terms'::regclass and conname = 'terms_half_check'
  ) then
    alter table terms add constraint terms_half_check check (half in (1, 2));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'terms'::regclass and conname = 'terms_range_check'
  ) then
    alter table terms add constraint terms_range_check check (end_date >= start_date);
  end if;
end $$;

-- 默认学年与学期（**只建缺的那几行，绝不覆盖教导处改过的日期**）。
-- 2026-2027 是"现在"那一个学年：2026-09 开学，所以当前学期 = 上半期 ——
-- P2 那 9 份作业与 1 场考试落在 2026 年 9 月，正好在它的区间里。
do $$
declare
  v_school uuid;
begin
  for v_school in select id from schools loop
    insert into academic_years (school_id, name, start_date, end_date)
    values (v_school, '2025-2026', date '2025-09-01', date '2026-08-31')
    on conflict do nothing;

    insert into academic_years (school_id, name, start_date, end_date)
    values (v_school, '2026-2027', date '2026-09-01', date '2027-08-31')
    on conflict do nothing;

    insert into terms (academic_year_id, half, start_date, end_date)
    select y.id, v.half, v.s, v.e
      from academic_years y
      cross join (values
        (1, date '2025-09-01', date '2026-01-31'),
        (2, date '2026-02-01', date '2026-08-31'),
        (1, date '2026-09-01', date '2027-01-31'),
        (2, date '2027-02-01', date '2027-08-31')
      ) as v(half, s, e)
     where y.school_id = v_school
       and (
         (y.name = '2025-2026' and v.s < date '2026-09-01')
         or (y.name = '2026-2027' and v.s > date '2026-08-31')
       )
    on conflict do nothing;
  end loop;
end $$;

-- -------- 28.2 档案的学期归属（`assignments` / `exams`）--------
alter table assignments add column if not exists term_id uuid references terms (id);
alter table exams       add column if not exists term_id uuid references terms (id);
create index if not exists assignments_term_idx on assignments (term_id, assign_date desc);
create index if not exists exams_term_idx       on exams (term_id, exam_date desc);

-- -------- 28.3 考试的**届**归属（Q33）--------
-- `exams.grade`（文本）**不删**：兼容期两条读法并存 —— 老档案只有文本，
-- 新档案两个都写。**判据一律读 `grade_id`**（文本会被改显示名，见 §2.13.1 的教训）。
-- 删年级时 `grade_id` 置空（`on delete set null`）：考试档案比年级行活得久。
alter table exams add column if not exists grade_id uuid references grades (id) on delete set null;
create index if not exists exams_grade_idx on exams (grade_id);

-- -------- 28.4 判据函数（**定义在引用它的东西之前**）--------

--  "现在"的北京时间日期。🔴 唯一一处"今天"的 SQL 口径 ——
--  与前端 `beijingNow()` 同源。**别用 `current_date`**（那是库的时区）。
create or replace function public.beijing_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Shanghai')::date;
$$;

--  按日期找学期：那一天落在哪个学期里。找不到 → **空**（绝不"就近归到某一学期"，I14）。
create or replace function public.term_of_date(p_date date)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.id
    from terms t
    join academic_years y on y.id = t.academic_year_id
   where p_date is not null
     and p_date between t.start_date and t.end_date
   order by t.start_date desc
   limit 1;
$$;

--  "当前学期" = 北京时间今天落在的那个学期。**推导值，不落列**。
create or replace function public.current_term_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select public.term_of_date(public.beijing_today());
$$;

--  这个学年属于哪所学校（写入口要用它判权限）。
--  🔴 与 §27.13 同一个形状：判据拆成 `_for` / 裸版两件套 ——
--     `write_academic_year()` 的 `revoke … from authenticated`（见下）不能撤，
--     服务端用 service_role 调它，而 service_role 下 `auth.uid()` 是 NULL。
create or replace function public.can_manage_terms_for(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_school_admin_for(p_uid);
$$;

create or replace function public.can_manage_terms()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_manage_terms_for(auth.uid());
$$;

-- -------- 28.5 教导处的写入口：设一个学年的上下半期（**一个事务**）--------
--  入参：**谁在写（`p_actor`）** + 学年名 + 两个半期的起止（4 个日期）。
--  一个 RPC = 一个事务 —— "只改了上半期、下半期还是老日期"是这一页最不能接受的失败样子。
--  ⚠️ 先 drop 旧签名（同 §27.13：`create or replace` 改不了签名，旧的重载会留下"另一个入口"）。
drop function if exists public.write_academic_year(text, date, date, date, date, date, date);
create or replace function public.write_academic_year(
  p_actor uuid,
  p_name text,
  p_year_start date,
  p_year_end date,
  p_half1_start date,
  p_half1_end date,
  p_half2_start date,
  p_half2_end date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school uuid;
  v_year   uuid;
begin
  if not public.can_manage_terms_for(p_actor) then
    raise exception '只有教导处 / 最高管理员能设学年与学期';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception '学年名不能空（形如 2026-2027）';
  end if;
  if p_half1_start is null or p_half1_end is null or p_half2_start is null or p_half2_end is null then
    raise exception '上下半期的起止日期四样都要填';
  end if;
  if p_year_end < p_year_start then
    raise exception '学年结束日期早于开始日期';
  end if;
  if p_half1_end < p_half1_start or p_half2_end < p_half2_start then
    raise exception '半期的结束日期早于开始日期';
  end if;
  if p_half2_start < p_half1_end then
    raise exception '下半期的开始日期早于上半期结束 —— 两个半期不许重叠';
  end if;

  select id into v_school from schools order by created_at limit 1;
  if v_school is null then
    raise exception '还没有学校行，先跑 schema.sql 第 10 段';
  end if;

  insert into academic_years (school_id, name, start_date, end_date)
  values (v_school, btrim(p_name), p_year_start, p_year_end)
  on conflict (school_id, name) do update
     set start_date = excluded.start_date,
         end_date   = excluded.end_date
  returning id into v_year;

  insert into terms (academic_year_id, half, start_date, end_date)
  values (v_year, 1, p_half1_start, p_half1_end)
  on conflict (academic_year_id, half) do update
     set start_date = excluded.start_date,
         end_date   = excluded.end_date;

  insert into terms (academic_year_id, half, start_date, end_date)
  values (v_year, 2, p_half2_start, p_half2_end)
  on conflict (academic_year_id, half) do update
     set start_date = excluded.start_date,
         end_date   = excluded.end_date;

  return jsonb_build_object('ok', true, 'academicYearId', v_year, 'name', btrim(p_name));
end $$;

revoke all on function public.write_academic_year(uuid, text, date, date, date, date, date, date)
  from public, anon, authenticated;
revoke all on function public.can_manage_terms_for(uuid) from public, anon, authenticated;

grant execute on function public.beijing_today() to authenticated;
grant execute on function public.term_of_date(date) to authenticated;
grant execute on function public.current_term_id() to authenticated;
grant execute on function public.can_manage_terms() to authenticated;

-- -------- 28.6 RLS：读得宽、写得窄（写只走服务端）--------
alter table academic_years enable row level security;
alter table terms          enable row level security;

drop policy if exists academic_years_read on academic_years;
create policy academic_years_read on academic_years
  for select to authenticated using (true);

drop policy if exists terms_read on terms;
create policy terms_read on terms
  for select to authenticated using (true);

grant select on academic_years, terms to authenticated;
revoke all on academic_years, terms from anon;

-- -------- 28.7 `grades` 唯一键改列（(school_id, name) → (school_id, cohort)）--------
--  🔴 顺序纪律（任何一刻都要有唯一性保证）：
--    ① **先确认没有冲突**（下面那个 do 块：查得出重复就**当场 raise**，绝不静默）；
--    ② **再建新的**唯一索引（`grades_school_cohort_key`，§27.1 已经建过一次，
--       这里再 `if not exists` 一次是为了"只跑本段"的库也能用）；
--    ③ **最后才 drop 旧的** `grades_school_name_key`。
--  ⚠️ 为什么现在能 drop 它：`grades.name` 降级为**显示名**（按 `stage` 渲染），
--     "两个高二（不同届）"必须允许 —— 留着按 name 的唯一索引就永远撞（Q22）。
--     ①§10.2 的 `insert into grades … on conflict do nothing` 已经改成
--     `where not exists`（不再依赖这条索引），②§27 的回填按 name 定位只发生在建索引之前。
do $$
declare
  v_dup text;
begin
  select string_agg(format('school=%s cohort=%s × %s 行', school_id, cohort, n), '；')
    into v_dup
    from (
      select school_id, cohort, count(*) as n
        from grades
       where cohort <> ''
       group by 1, 2
      having count(*) > 1
    ) d;
  if v_dup is not null then
    raise exception '同一届出现了不止一个年级（%）。先把重复的那几行合并或删掉，再跑本段 —— 否则唯一索引建不起来', v_dup;
  end if;
end $$;

create unique index if not exists grades_school_cohort_key
  on grades (school_id, cohort) where cohort <> '';

drop index if exists grades_school_name_key;

-- ✅ 三个届的回填（**只填空的，绝不覆盖**；高一 = 2026 / 高二 = 2025 / 高三 = 2024）。
--    ⚠️ 只碰 `cohort` 与 `stage` 两列，**绝不碰 `name`**（`grades` 的字段是权限判据的一环，I30）。
update grades set cohort = '2026' where cohort = '' and name = '高一';
update grades set cohort = '2025' where cohort = '' and name = '高二';
update grades set cohort = '2024' where cohort = '' and name = '高三';
update grades set stage  = 1 where stage is distinct from 1 and cohort = '2026';
update grades set stage  = 2 where stage is distinct from 2 and cohort = '2025';
update grades set stage  = 3 where stage is distinct from 3 and cohort = '2024';

-- -------- 28.8 🔑 P2：存量回填（**幂等 —— 重跑受影响行数 = 0**）--------
--  回填四样（序列号那一样 P1 已经做过，本函数只**复核**、不重做）：
--    ① 作业的学期归属（`assignments.term_id`）
--    ② 考试的学期归属（`exams.term_id`）
--    ③ 考试的届归属（`exams.grade_id`）
--    ④ 序列号复核（`students.serial = ''` 的条数，**只报不补**）
--
--  🔴 **幂等的根据是每一条 SQL 的 `where <目标列为空>`** —— 重跑时已填好的行
--     不在 `where` 里，所以第二次跑回来就是 0 行。**不靠"猜键的形状"**。
--  🔴 **"补不上"不许静默**：本函数把 fillable / filled / unresolvable 三个数一起报出来；
--     `unresolvable > 0` 时**再 raise warning**，让人在 SQL 编辑器里看得见。
--
--  ⚠️ 回填必须发生在**第一次提档之前**：`exams.grade` 文本现在等于 `grades.name`，
--     提档之后 `name` 会变成"高二（2025 级）"这类渲染名，文本反查就断了（§2.13 / P2 的硬理由）。
--  ⚠️ "测试专用"班：它没有作业也没有考试，所以**天然零改动**；
--     万一将来给它建了档案，学期回填按日期填 —— 那是正确的归属，不是"误伤"。
create or replace function public.p3_backfill_terms_and_cohorts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_assign_filled int := 0;
  n_exam_term     int := 0;
  n_exam_grade    int := 0;
  n_assign_open   int := 0;
  n_exam_open     int := 0;
  n_exam_nograde  int := 0;
  n_serial_open   int := 0;
begin
  -- ① 作业 → 学期（按 `assign_date` 落在哪个学期）
  update assignments a
     set term_id = t.id
    from terms t
   where a.term_id is null
     and a.assign_date between t.start_date and t.end_date;
  get diagnostics n_assign_filled = row_count;

  -- ② 考试 → 学期（按 `exam_date`）
  update exams e
     set term_id = t.id
    from terms t
   where e.term_id is null
     and e.exam_date between t.start_date and t.end_date;
  get diagnostics n_exam_term = row_count;

  -- ③ 考试 → 届（按年级名文本反查 `grades`；同一所学校内认不出就**留空**）
  update exams e
     set grade_id = g.id
    from grades g
   where e.grade_id is null
     and btrim(e.grade) <> ''
     and g.school_id = (select id from schools order by created_at limit 1)
     and (g.name = btrim(e.grade) or g.cohort = btrim(e.grade));
  get diagnostics n_exam_grade = row_count;

  -- ④ 复核（**不写**）
  select count(*) into n_serial_open from students where coalesce(serial, '') = '';
  select count(*) into n_assign_open from assignments where term_id is null;
  select count(*) into n_exam_open   from exams       where term_id is null;
  select count(*) into n_exam_nograde from exams
   where grade_id is null and coalesce(btrim(grade), '') <> '';

  if n_assign_open > 0 or n_exam_open > 0 or n_exam_nograde > 0 or n_serial_open > 0 then
    raise warning '还有补不上的存量：作业无学期 % 条 / 考试无学期 % 条 / 考试无届 % 条 / 学生无序列号 % 人',
      n_assign_open, n_exam_open, n_exam_nograde, n_serial_open;
  end if;

  return jsonb_build_object(
    'ok', true,
    'assignmentsTermFilled', n_assign_filled,
    'examsTermFilled', n_exam_term,
    'examsGradeFilled', n_exam_grade,
    'unresolvable', jsonb_build_object(
      'assignmentsNoTerm', n_assign_open,
      'examsNoTerm', n_exam_open,
      'examsNoGrade', n_exam_nograde,
      'studentsNoSerial', n_serial_open
    )
  );
end $$;

revoke all on function public.p3_backfill_terms_and_cohorts() from public, anon;

-- ✅ 落地那一刻就跑一次（幂等：手动再跑一遍是 0 行）
select public.p3_backfill_terms_and_cohorts();

-- -------- 28.9 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 学年与学期建好了、当前学期推得出来：
--  -- select y.name, t.half, t.start_date, t.end_date,
--  --        (t.id = public.current_term_id()) as 是当前学期
--  --   from terms t join academic_years y on y.id = t.academic_year_id
--  --  order by t.start_date;
--  -- 期望：4 行；"是当前学期"在 2026-09 ~ 2027-01 那一行是 true
--
--  ② 回填幂等（**跑两遍，第二遍三个数都是 0**）：
--  -- select public.p3_backfill_terms_and_cohorts();
--  -- select public.p3_backfill_terms_and_cohorts();
--
--  ③ 补不上的清单（期望四项全 0；非 0 就要一份写明原因的清单）：
--  -- select 'assignments 无学期' as 项, count(*) from assignments where term_id is null
--  -- union all select 'exams 无学期',      count(*) from exams where term_id is null
--  -- union all select 'exams 无届',        count(*) from exams where grade_id is null and btrim(grade) <> ''
--  -- union all select 'students 无序列号', count(*) from students where coalesce(serial,'') = '';
--
--  ④ 三个届与唯一键：
--  -- select name, cohort, stage from grades order by stage;
--  -- 期望：高一 2026 1 / 高二 2025 2 / 高三 2024 3
--  -- select indexname from pg_indexes where tablename = 'grades';
--  -- 期望：grades_school_cohort_key 在，grades_school_name_key **不在**
--  -- 反向对照（两条都要能跑）：
--  -- insert into grades (school_id, name, cohort) select id, '高二', '2025' from schools limit 1;  -- 应被拒（同届）
--  -- insert into grades (school_id, name, cohort) select id, '高二', '2027' from schools limit 1;  -- 应通过（两个高二）
--
--  ⑤ 提档只改 `stage`（**年级 id 不变** → 班级的 `grade_id` 一个字都不用改）：
--  -- select c.id, c.grade_id from classes c join grades g on g.id = c.grade_id where g.cohort = '2025';
--  -- select public.promote_grades('<你的 teacher id>');   -- 提档（P4 已做成函数，见 §29）
--  -- select c.id, c.grade_id from classes c join grades g on g.id = c.grade_id where g.cohort = '2025';
--  -- 期望：两边的 grade_id **逐字相同**
-- ============================================================

-- ============================================================
--  29. 提档 + 毕业删除（P4，2026-10-01）
--      「一年一度把 `stage` +1 · 高三毕业**真删**一个年级的全部数据」
-- ------------------------------------------------------------
--  施工图：`选科走班实施计划.md` 的 **P4 段**；决策：`年级管理与选科走班方案.md`
--  §2.6（毕业删除整节）/ §2.7（身份撤回的边界）/ §4.2.4(3)(4)（状态机 + 两个事务）/
--  §4.2.5（权限矩阵）/ §4.2.6（每一步的校验与防呆）；
--  用户拍板：**Q10 = A（真删，不归档、没有冷却期）· Q16（提档不撤回任何身份）·
--  Q30（撤回只发生在毕业删除那一次，而且**随删除立刻**撤）**。
--
--  🔴 四条口径（改这一段之前先读这里）：
--    ① **提档只改 `stage`，年级 id 不变** —— 班级 / 走班班 / 课表的 `grade_id`
--       一个字都不用改（§28.3 的全部收益）。**一个学年只提一次**（`grade_promotions`
--       的唯一键 `(school_id, academic_year)` 就是幂等的根据）；重跑**一行数据都不改**。
--    ② **提档不撤回任何身份**（Q16）：这个事务里**没有** `delete from teacher_roles` ——
--       原方案 §4.2.4(3) 的第 4 步（撤回年级主任 / 班主任）**搬到了 `grade_delete()` 里**。
--    ③ **毕业删除是不可逆的 DELETE**（Q10 = A）：保护只有
--       **备份已发出**（`grade_removals.mail_ok`）+ **逐字输入年级全名**
--       + **只有 `is_super_admin()`**。**没有归档、没有冷却期、"删除"就是 DELETE。**
--    ④ 🔴 **"清干净不留残留"= 一张清点表**（§2.6）：凡是**级联删不到**的都要显式删 ——
--       · `exams.class_ids` 是 `uuid[]`、**建不了外键** → 会留下"一条分数都没有的孤儿考试档案"；
--       · `teacher_roles.scope_id` **没有外键** → 会留下"管着一个不存在年级"的身份行；
--       · 🆕 `shared_files.class_ids` **同样是 `uuid[]`**（§19.1）—— 这是**本轮新发现的
--         第三类数组残留**（§2.6 的清点表只列了前两类）。处理方式：把本届班的 id 从数组里
--         **减掉**（不是删行：一份文件可能同时发给两个年级），减空了才删行，
--         并把 `storage_path` 交给服务端删对象存储（否则存储里留下不可达对象）；
--       · `schedule_items.class_id` 是 **`on delete set null`**（不是 cascade）→ 悬空排课行；
--       其余 11 处由 `classes` / `students` / `exams` / `grades` 的 cascade 带走，**逐条校验**。
--
--  ⚠️ **写入口一律只有服务端能调**（下面逐个 `revoke … from public, anon, authenticated`）：
--     `app/functions/api/grade-promote.ts` 用 service_role 调它们，并把**显式 `p_actor`**
--     传进来 —— 那个 id 是 Function 拿调用者 JWT 问过 `/auth/v1/user` 的（§18.1 的两件套）。
--     🔴 **为什么不照 §27.12 那样"让 Function 拿调用者 JWT 去调"**：那些写函数已经被
--     `revoke … from authenticated`，而 PostgREST 以 `authenticated` 角色执行 ——
--     拿调用者 JWT 调**必然 42501**（`grade-setup.ts` 的三个写动作今天就是这个形状，
--     已登记在报告里）。所以本段的写函数走"service_role + 显式人"，
--     判据仍然是**数据库说了算**（`*_for(p_actor, …)`）。
-- ============================================================

-- -------- 29.1 两张新表（**都必须比 `grades` 行活得久**）--------

-- 提档的**幂等根据 + 审计**：一个学校一个学年一行。
create table if not exists grade_promotions (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references schools (id) on delete cascade,
  -- 学年名，口径与 `academic_years.name` 一致（形如 `2026-2027`，由 `current_academic_year()` 推）
  academic_year text not null,
  -- 谁提的档。**故意没有外键**：审计行不该因为教师账号被删而消失
  actor_id      uuid,
  promoted_at   timestamptz not null default now(),
  -- 提档前后的 `{id, name, cohort, stage}` 快照（改了什么，一眼看得见）
  detail        jsonb not null default '{}'::jsonb
);
create unique index if not exists grade_promotions_school_year_key
  on grade_promotions (school_id, academic_year);

-- 毕业删除的**完整状态**：备份（payload）→ 发信 → 删除报告。
--  🔴 `grade_id` / `school_id` **故意没有外键** —— 年级行删掉以后，这一行必须还在
--     （"这一届什么时候删的、删掉了什么、备份存哪、链接还有效吗"都得查得到）。
--  🔴 `payload` 里有**学生姓名与序列号** → 这张表对 anon / authenticated
--     **一个权限都不给**（RLS 开着 + 一条策略都没有 + 下面 revoke），只有服务端读得到。
create table if not exists grade_removals (
  id               uuid primary key default gen_random_uuid(),
  grade_id         uuid not null,
  school_id        uuid not null,
  cohort           text not null default '',
  -- 删除前记下的年级全名（年级行没了以后，界面与报告要靠它说话）
  grade_name       text not null default '',
  -- 二次确认要逐字输入的那串字（服务端算出来的唯一一份，前端只负责显示与回传）
  confirm_name     text not null default '',
  created_at       timestamptz not null default now(),
  created_by       uuid,
  payload          jsonb,
  payload_bytes    bigint not null default 0,
  -- 校验和（`md5`，**不是**安全哈希 —— 它只用来回答"这一份是不是那一份"）
  payload_md5      text not null default '',
  -- 备份那一刻的逐项条数（邮件与"给教导处弹提示"都用它，**不含任何个人信息**）
  counts           jsonb not null default '{}'::jsonb,
  mail_ok          boolean not null default false,
  mail_at          timestamptz,
  mail_reason      text not null default '',
  token            text not null default '',
  expires_at       timestamptz,
  download_count   int not null default 0,
  last_download_at timestamptz,
  deleted_at       timestamptz,
  deleted_by       uuid,
  report           jsonb,
  -- 删行时收集的对象存储路径（服务端拿它删 storage 里的对象）
  storage_paths    jsonb not null default '[]'::jsonb
);
create unique index if not exists grade_removals_grade_key on grade_removals (grade_id);
create unique index if not exists grade_removals_token_key on grade_removals (token) where token <> '';

-- -------- 29.2 小工具与判据（**定义在引用它的东西之前**）--------

-- 「这一天属于哪个学年」= 北京时间 **9/1 起算**的学年名（形如 `2026-2027`）。
--  ⚠️ 与 `academic_years.name` **同一个口径**（教导处在 `/settings/terms` 设的就是它）——
--     这样 `grade_promotions.academic_year` 与学期表对得上。
create or replace function public.academic_year_name_of(p_date date)
returns text
language sql
immutable
as $$
  select case
           when p_date is null then null
           when extract(month from p_date) >= 9
             then to_char(p_date, 'YYYY') || '-' || to_char(p_date + interval '1 year', 'YYYY')
           else to_char(p_date - interval '1 year', 'YYYY') || '-' || to_char(p_date, 'YYYY')
         end;
$$;

-- 「现在是哪个学年」= 按**北京时间**推（与前端 `beijingNow()` 同源；别用 `current_date`）。
create or replace function public.current_academic_year()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.academic_year_name_of(public.beijing_today());
$$;

-- 年级全名（**二次确认要逐字输入的那串字**，也是界面上显示的名字）。
--  🔴 **只有这一处定义**：前端不另写一套渲染，服务端算出来、前端显示它、回传它。
create or replace function public.grade_full_name(p_grade_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select (case g.stage when 1 then '高一' when 2 then '高二' when 3 then '高三'
                         else '学段' || g.stage::text end)
           || (case when coalesce(g.cohort, '') = '' then '（届未知）'
                    else '（' || g.cohort || ' 级）' end)
      from grades g
     where g.id = p_grade_id
  ), '');
$$;

-- 我能不能提档：**教导处 + 最高管理员**（方案 §4.2.5 那一行；年级主任 ❌）。
create or replace function public.can_promote_grades_for(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_school_admin_for(p_uid);
$$;

create or replace function public.can_promote_grades()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_promote_grades_for(auth.uid());
$$;

-- 我能不能**毕业删除**这个年级：🔴 `is_super_admin()` **且** 备份已成功发出
--  **且** 备份链接还没过期 **且** 这个年级还在。
--  ⚠️ "已二次确认"**不在这里**：那一件事没有持久状态（它是"这一次调用里输入的年级全名对不对"），
--     判在 `grade_delete()` 里 —— 一件事只有一个判定入口，但它是**调用时**的判定。
create or replace function public.can_delete_grade_for(p_uid uuid, p_grade_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin_for(p_uid)
     and exists (select 1 from grades g where g.id = p_grade_id)
     and exists (
           select 1 from grade_removals r
            where r.grade_id = p_grade_id
              and r.mail_ok
              and r.deleted_at is null
              and (r.expires_at is null or r.expires_at > now())
         );
$$;

create or replace function public.can_delete_grade(p_grade_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_delete_grade_for(auth.uid(), p_grade_id);
$$;

-- -------- 29.3 只读：提档预览 + 待删提示（**前端只读它**）--------
--  返回的都是**非个人**的东西（年级 / 条数 / 备份状态）。非管理身份一律
--  `{allowed:false, grades:[]}`（他们本来也到不了那一页，这里是纵深防御）。
create or replace function public.promotion_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_today date := public.beijing_today();
  v_year text := public.academic_year_name_of(v_today);
  v_school uuid;
  v_promoted timestamptz;
  v_grades jsonb;
begin
  if not public.is_school_admin_for(v_uid) then
    return jsonb_build_object('allowed', false, 'grades', '[]'::jsonb);
  end if;

  select id into v_school from schools order by created_at limit 1;
  if v_school is null then
    return jsonb_build_object('allowed', false, 'grades', '[]'::jsonb, 'message', '还没有学校行');
  end if;

  select promoted_at into v_promoted
    from grade_promotions
   where school_id = v_school and academic_year = v_year;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',        g.id,
           'name',      g.name,
           'cohort',    g.cohort,
           'stage',     g.stage,
           'fullName',  public.grade_full_name(g.id),
           'classes',   (select count(*) from classes c where c.grade_id = g.id),
           'students',  (select count(*) from students s
                           join classes c2 on c2.id = s.class_id
                          where c2.grade_id = g.id),
           -- 备份那一行（服务端下载备份要用它的 id；`deleted_at` 不为空 = 已经删过了）
           'removalId', r.id,
           'mailOk',    coalesce(r.mail_ok, false),
           'mailAt',    r.mail_at,
           'mailReason', coalesce(r.mail_reason, ''),
           'backupAt',  r.created_at,
           'removedAt', r.deleted_at
         ) order by g.stage, g.cohort), '[]'::jsonb)
    into v_grades
    from grades g
    left join grade_removals r on r.grade_id = g.id
   where g.school_id = v_school;

  return jsonb_build_object(
    'allowed',      true,
    'today',        v_today,
    'academicYear', v_year,
    -- 提档窗口：**每年 9/1 之后**（9 月之前跑提档 = 让全年级白读一年，必须拦住）
    'windowOpen',   extract(month from v_today) >= 9,
    'promotedAt',   v_promoted,
    'grades',       v_grades
  );
end $$;

-- -------- 29.4 🔑 提档（**一个事务 · 幂等 · 只改 `stage`**）--------
create or replace function public.promote_grades(p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school uuid;
  v_year   text := public.current_academic_year();
  v_rows   int := 0;
  v_before jsonb;
  v_after  jsonb;
  v_detail jsonb;
begin
  if not public.can_promote_grades_for(p_actor) then
    raise exception '只有教导处 / 最高管理员能提档';
  end if;
  if extract(month from public.beijing_today()) < 9 then
    raise exception '提档在每年 9 月 1 日之后做 —— 今天是 %，还没到那一年', public.beijing_today();
  end if;

  select id into v_school from schools order by created_at limit 1;
  if v_school is null then
    raise exception '还没有学校行，先跑 schema.sql 第 10 段';
  end if;

  /*
   * 🔴 **幂等**：这一个学年提过 → 直接返回，**一行数据都不改**。
   *    根据是 `grade_promotions` 的唯一键（(school_id, academic_year)），
   *    不是"猜 stage 跑到哪了" —— 后者在"高一高二并存"的库里一定会猜错。
   */
  select detail into v_detail
    from grade_promotions
   where school_id = v_school and academic_year = v_year;
  if found then
    return jsonb_build_object(
      'ok', true, 'alreadyPromoted', true, 'academicYear', v_year, 'promoted', 0,
      'before', coalesce(v_detail -> 'before', '[]'::jsonb),
      'after',  coalesce(v_detail -> 'after',  '[]'::jsonb));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'name', g.name, 'cohort', g.cohort, 'stage', g.stage)
           order by g.stage, g.cohort), '[]'::jsonb)
    into v_before
    from grades g where g.school_id = v_school;

  insert into grade_promotions (school_id, academic_year, actor_id)
  values (v_school, v_year, p_actor);

  /*
   * 🔴 **只有这一句改数据**：`stage + 1`，而且只对 1 / 2 提（高三停在 3，
   *    等 §29.5 的毕业删除）。年级 id 不变 → 班级 / 走班班 / 课表的 `grade_id` 不用改。
   * 🔴 这里**没有** `delete from teacher_roles`（Q16：提档不撤回任何身份）。
   */
  update grades set stage = stage + 1
   where school_id = v_school and stage in (1, 2);
  get diagnostics v_rows = row_count;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'name', g.name, 'cohort', g.cohort, 'stage', g.stage)
           order by g.stage, g.cohort), '[]'::jsonb)
    into v_after
    from grades g where g.school_id = v_school;

  update grade_promotions
     set detail = jsonb_build_object('before', v_before, 'after', v_after, 'rows', v_rows)
   where school_id = v_school and academic_year = v_year;

  return jsonb_build_object(
    'ok', true, 'alreadyPromoted', false, 'academicYear', v_year, 'promoted', v_rows,
    'before', v_before, 'after', v_after);
end $$;

-- -------- 29.5 🔑 备份（**payload 的唯一构造处**，服务端与下载链接共用）--------
--  ⚠️ 里面一律写 `array(select id from classes where grade_id = p_grade_id)`，**不写**
--     `(select coalesce(array_agg(...), '{}'))` 再 `= any (…)` ——
--     后者会被 PostgreSQL 解析成 `expr = ANY (子查询)`（= `IN (子查询)`），
--     子查询那一列是 **uuid[]**，于是报 `operator does not exist: uuid = uuid[]`
--     （实测：建函数那一刻就断，整份 schema 跑不过去）。`array(子查询)` 才是"数组表达式"。
create or replace function public.grade_backup_payload_json(p_grade_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with c as (
    select * from classes where grade_id = p_grade_id
  ), s as (
    select st.* from students st join c on c.id = st.class_id
  ), ex as (
    select e.* from exams e
     where e.class_ids && array(select c2.id from c c2)
  ), tids as (
    select array(select c3.id from c c3) as v
  )
  select jsonb_build_object(
    'format', 'grade-backup.v1',
    'at', now(),
    'grade', (select to_jsonb(g) from grades g where g.id = p_grade_id),
    'counts', jsonb_build_object(
      'classes',      (select count(*) from c),
      'students',     (select count(*) from s),
      'assignments',  (select count(*) from assignments a where a.class_id in (select id from c)),
      'calls',        (select count(*) from calls x where x.class_id in (select id from c)),
      'exams',        (select count(*) from ex),
      'examScores',   (select count(*) from exam_scores es where es.class_id in (select id from c)),
      'classSubjects', (select count(*) from class_subjects cs where cs.class_id in (select id from c)),
      'classMembers', (select count(*) from class_members cm where cm.class_id in (select id from c)),
      'studentSubjects', (select count(*) from student_subjects ss
                           where ss.student_id in (select id from s)),
      'scheduleItems', (select count(*) from schedule_items si where si.class_id in (select id from c)),
      'classroomAccounts', (select count(*) from classroom_accounts ca where ca.class_id in (select id from c)),
      'sharedFiles',  (select count(*) from shared_files f
                        where coalesce(f.class_ids, '{}'::uuid[]) && (select v from tids)
                           or f.class_id in (select id from c)),
      'teacherRoles', (select count(*) from teacher_roles r
                        where r.scope_id = p_grade_id
                           or (r.scope_type = 'class' and r.scope_id in (select id from c)))
    ),
    'tables', jsonb_build_object(
      'grades',     coalesce((select jsonb_agg(to_jsonb(g)) from grades g where g.id = p_grade_id), '[]'::jsonb),
      'classes',    coalesce((select jsonb_agg(to_jsonb(x)) from c x), '[]'::jsonb),
      'students',   coalesce((select jsonb_agg(to_jsonb(x)) from s x), '[]'::jsonb),
      'studentSubjects', coalesce((select jsonb_agg(to_jsonb(x)) from student_subjects x
                                    where x.student_id in (select id from s)), '[]'::jsonb),
      'classMembers', coalesce((select jsonb_agg(to_jsonb(x)) from class_members x
                                 where x.class_id in (select id from c)
                                    or x.student_id in (select id from s)), '[]'::jsonb),
      'classSubjects', coalesce((select jsonb_agg(to_jsonb(x)) from class_subjects x
                                  where x.class_id in (select id from c)), '[]'::jsonb),
      'assignments', coalesce((select jsonb_agg(to_jsonb(x)) from assignments x
                                where x.class_id in (select id from c)), '[]'::jsonb),
      'calls',      coalesce((select jsonb_agg(to_jsonb(x)) from calls x
                               where x.class_id in (select id from c)), '[]'::jsonb),
      'exams',      coalesce((select jsonb_agg(to_jsonb(x)) from ex x), '[]'::jsonb),
      'examScores', coalesce((select jsonb_agg(to_jsonb(x)) from exam_scores x
                               where x.class_id in (select id from c)), '[]'::jsonb),
      'scheduleItems', coalesce((select jsonb_agg(to_jsonb(x)) from schedule_items x
                                  where x.class_id in (select id from c)), '[]'::jsonb),
      'classroomAccounts', coalesce((select jsonb_agg(to_jsonb(x)) from classroom_accounts x
                                      where x.class_id in (select id from c)), '[]'::jsonb),
      'classrooms', coalesce((select jsonb_agg(to_jsonb(x)) from classrooms x
                               where x.class_id in (select id from c)), '[]'::jsonb),
      'sharedFiles', coalesce((select jsonb_agg(to_jsonb(x)) from shared_files x
                                where coalesce(x.class_ids, '{}'::uuid[]) && (select v from tids)
                                   or x.class_id in (select id from c)), '[]'::jsonb),
      'teacherRoles', coalesce((select jsonb_agg(to_jsonb(x)) from teacher_roles x
                                 where x.scope_id = p_grade_id
                                    or (x.scope_type = 'class' and x.scope_id in (select id from c))), '[]'::jsonb)
    )
  );
$$;

-- -------- 29.6 🔑 生成备份（**一个事务**：payload + 链接令牌 + 状态行）--------
--  ① 谁：教导处 / 最高管理员（备份是防呆的第一步，不是删除本身）
--  ② 幂等：一个年级一行（`unique (grade_id)`），重做 = 覆盖并把 `mail_ok` 打回 false
--     （**必须重新发信**：新备份 = 新链接）
create or replace function public.grade_backup(p_actor uuid, p_grade_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_full    text;
  v_cohort  text;
  v_school  uuid;
  v_payload jsonb;
  v_token   text;
  v_h       text;
  v_id      uuid;
  v_expires timestamptz := now() + interval '90 days';
  v_paths   jsonb;
begin
  if not public.is_school_admin_for(p_actor) then
    raise exception '只有教导处 / 最高管理员能生成毕业备份';
  end if;

  select public.grade_full_name(g.id), g.cohort, g.school_id
    into v_full, v_cohort, v_school
    from grades g where g.id = p_grade_id;
  if coalesce(v_full, '') = '' then
    raise exception '这个年级不存在（可能已经删了）';
  end if;

  v_payload := public.grade_backup_payload_json(p_grade_id);
  v_paths   := coalesce(v_payload #> '{tables,sharedFiles}', '[]'::jsonb);

  /*
   * 🔴 令牌**不许出现连续 7 位数字**：`_lib/mail.ts` 的正文体检把"7 位数字"
   *    当成序列号形状，命中就**整封信不发**（`reason:'pii_blocked'`）——
   *    而裸 uuid 的十六进制段里出现 7 连数字是有概率的，那就成了
   *    "有时发得出去、有时发不出去"（最坏的一种失败：删除流程随机卡住）。
   *    所以：6 位一组、组间插一个字母（每组最多 6 位数字 → 永远不会有 7 连）。
   */
  v_h := replace(gen_random_uuid()::text || replace(gen_random_uuid()::text, '-', ''), '-', '');
  v_token := 'bk' || substr(v_h, 1, 6) || 'x' || substr(v_h, 7, 6) || 'x'
                  || substr(v_h, 13, 6) || 'x' || substr(v_h, 19, 6) || 'x' || substr(v_h, 25, 6);

  insert into grade_removals (
    grade_id, school_id, cohort, grade_name, confirm_name, created_by,
    payload, payload_bytes, payload_md5, counts, token, expires_at, storage_paths,
    mail_ok, mail_at, mail_reason)
  values (
    p_grade_id, v_school, v_cohort, v_full, v_full, p_actor,
    v_payload, octet_length(v_payload::text), md5(v_payload::text),
    coalesce(v_payload -> 'counts', '{}'::jsonb), v_token, v_expires, v_paths,
    false, null, '')
  on conflict (grade_id) do update
     set cohort        = excluded.cohort,
         grade_name    = excluded.grade_name,
         confirm_name  = excluded.confirm_name,
         created_at    = now(),
         created_by    = excluded.created_by,
         payload       = excluded.payload,
         payload_bytes = excluded.payload_bytes,
         payload_md5   = excluded.payload_md5,
         counts        = excluded.counts,
         token         = excluded.token,
         expires_at    = excluded.expires_at,
         storage_paths = excluded.storage_paths,
         mail_ok       = false,
         mail_at       = null,
         mail_reason   = ''
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'removalId', v_id,
    'token', v_token,
    'expiresAt', v_expires,
    'confirmName', v_full,
    'gradeName', v_full,
    'cohort', v_cohort,
    'checksum', md5(v_payload::text),
    'byteSize', octet_length(v_payload::text),
    'counts', coalesce(v_payload -> 'counts', '{}'::jsonb));
end $$;

-- 登记"信发出去了没有"（服务端在 `sendAuditedMail()` 之后调它）。
--  🔴 **它自己不是安全边界**：真正的闸门是 `is_super_admin()` + 逐字全名。
--     它的作用是让"备份没发出 = 删不了"这条规则**在数据库里有据可查**。
create or replace function public.grade_backup_mail(
  p_actor uuid,
  p_removal_id uuid,
  p_ok boolean,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_school_admin_for(p_actor) then
    raise exception '只有教导处 / 最高管理员能登记备份发信结果';
  end if;
  update grade_removals
     set mail_ok     = coalesce(p_ok, false),
         mail_at     = case when coalesce(p_ok, false) then now() else mail_at end,
         mail_reason = coalesce(p_reason, '')
   where id = p_removal_id;
  if not found then
    raise exception '找不到这条备份记录';
  end if;
  return jsonb_build_object('ok', true, 'mailOk', coalesce(p_ok, false));
end $$;

-- 服务端（超管）在页面上下载备份：判据 = 教导处 / 超管。
create or replace function public.grade_backup_payload(p_actor uuid, p_removal_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rec grade_removals;
begin
  if not public.is_school_admin_for(p_actor) then
    raise exception '只有教导处 / 最高管理员能取备份';
  end if;
  select * into v_rec from grade_removals where id = p_removal_id;
  if v_rec.id is null then
    raise exception '找不到这条备份记录';
  end if;
  return jsonb_build_object(
    'ok', true, 'gradeName', v_rec.grade_name, 'cohort', v_rec.cohort,
    'deletedAt', v_rec.deleted_at, 'checksum', v_rec.payload_md5,
    'byteSize', v_rec.payload_bytes, 'counts', v_rec.counts, 'payload', v_rec.payload);
end $$;

-- 邮件里那个**下载链接**（令牌即凭据，有效期是唯一的访问控制 —— §4.2.7 / U-14 = C）。
--  🔴 **每一次下载都记一笔**（`download_count` / `last_download_at`）：
--     备份会离开系统，出去以后只能靠这条记录回答"谁什么时候取过"。
create or replace function public.grade_backup_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec grade_removals;
begin
  select * into v_rec from grade_removals where token = btrim(coalesce(p_token, ''));
  if v_rec.id is null then
    raise exception '这个下载链接不认识（重新生成过备份的链接会失效）';
  end if;
  if v_rec.expires_at is not null and v_rec.expires_at <= now() then
    raise exception '这个下载链接已经过期（%）—— 让超管重新生成一份备份', v_rec.expires_at;
  end if;
  update grade_removals
     set download_count = download_count + 1, last_download_at = now()
   where id = v_rec.id;
  return jsonb_build_object(
    'ok', true, 'gradeName', v_rec.grade_name, 'cohort', v_rec.cohort,
    'deletedAt', v_rec.deleted_at, 'checksum', v_rec.payload_md5,
    'byteSize', v_rec.payload_bytes, 'counts', v_rec.counts, 'payload', v_rec.payload);
end $$;

-- -------- 29.7 🔴🔴 毕业删除（**一个事务 · 五道保护 · 清残留清点表**）--------
--  保护（§2.6 的五步落成代码，**这就是全部保护** —— 没有归档、没有冷却期）：
--    ① 备份成功（`grade_removals` 有行、有 payload）
--    ② 备份**已发出**（`mail_ok`）—— 没发出 = 这一步走不下去
--    ③ 给教导处弹提示：由 `promotion_overview()` + 页面横幅承担（数据层不做弹窗）
--    ④ 二次确认：**逐字输入年级全名**（比对的就是 `grade_full_name()`）
--    ⑤ 清干净：下面**逐项显式删** + 逐项后置校验（任何一项非 0 → **整件事回滚**）
--  权限：**只有 `is_super_admin()`**（`can_delete_grade_for()` 问了同一个判据）。
create or replace function public.grade_delete(
  p_actor uuid,
  p_grade_id uuid,
  p_confirm_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec        grade_removals;
  v_full       text;
  v_cohort     text;
  v_class_ids  uuid[] := '{}'::uuid[];
  v_teachers   uuid[] := '{}'::uuid[];
  v_shared_ids uuid[] := '{}'::uuid[];
  v_accounts   jsonb := '[]'::jsonb;
  v_storage    jsonb := '[]'::jsonb;
  v_counts     jsonb;
  v_checks     jsonb;
  v_report     jsonb;
  v_bad        text;
  n_exams      int := 0;
  n_roles      int := 0;
  n_sched      int := 0;
  n_classes    int := 0;
  n_trim       int := 0;
  n_files      int := 0;
  n_tmp        int := 0;
begin
  /* ---- ① 权限：**只有超管** ---- */
  if not public.is_super_admin_for(p_actor) then
    raise exception '毕业删除只有最高管理员能做 —— 教导处可以备份、可以看提示，但不能删';
  end if;

  /* ---- 幂等：这个年级已经删过了 → 把上一次的报告原样返回，**一个字都不改** ---- */
  if not exists (select 1 from grades g where g.id = p_grade_id) then
    select * into v_rec from grade_removals where grade_id = p_grade_id;
    if v_rec.id is not null and v_rec.deleted_at is not null then
      return jsonb_build_object(
        'ok', true, 'alreadyDeleted', true, 'gradeName', v_rec.grade_name,
        'deletedAt', v_rec.deleted_at, 'confirmName', v_rec.confirm_name,
        'report', v_rec.report, 'storagePaths', '[]'::jsonb,
        'classroomAccounts', '[]'::jsonb);
    end if;
    raise exception '这个年级不存在（可能已经删了，也可能 id 不对）';
  end if;

  /* ---- ② 备份：存在 + 已发出 + 没过期 ---- */
  select * into v_rec from grade_removals where grade_id = p_grade_id;
  if v_rec.id is null then
    raise exception '还没有备份 —— 毕业删除的第一步是「生成备份并发到超管邮箱」，先做那一步';
  end if;
  if not v_rec.mail_ok then
    raise exception '备份还没有发到超管邮箱（%）—— 删除流程停在这里：先把信发出去',
      coalesce(nullif(v_rec.mail_reason, ''), '原因不明');
  end if;
  if v_rec.expires_at is not null and v_rec.expires_at <= now() then
    raise exception '备份的下载链接已经过期（%）—— 重新生成一份备份、重新发信之后再删', v_rec.expires_at;
  end if;
  if v_rec.payload is null then
    raise exception '这条备份记录里没有内容 —— 重新生成一份备份';
  end if;

  /* ---- ④ 二次确认：**逐字**输入年级全名 ----
     ⚠️ 比对时把**空格**两边都去掉（"高三（2024 级）"里那个空格是渲染出来的，
        不该因为少打一个空格就让人以为"名字错了"）；其余字符逐字比。 */
  v_full := public.grade_full_name(p_grade_id);
  select g.cohort into v_cohort from grades g where g.id = p_grade_id;
  if replace(btrim(coalesce(p_confirm_name, '')), ' ', '') <> replace(v_full, ' ', '') then
    raise exception '年级全名不对 —— 要**逐字**输入「%」才放行（这次收到的是「%」）',
      v_full, btrim(coalesce(p_confirm_name, ''));
  end if;

  /* ---- 清残留：先取一份"这一届的范围"（后面的显式删都靠它） ---- */
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_class_ids
    from classes c where c.grade_id = p_grade_id;

  select coalesce(array_agg(distinct t), '{}'::uuid[]) into v_teachers
    from (
      select c.teacher_id as t from classes c where c.grade_id = p_grade_id
      union
      select cs.teacher_id from class_subjects cs where cs.class_id = any (v_class_ids)
      union
      select r.teacher_id from teacher_roles r
       where r.scope_id = p_grade_id
          or (r.scope_type = 'class' and r.scope_id = any (v_class_ids))
    ) x
   where t is not null;

  /* 删之前各有多少（给教导处看"什么将永久消失"，也是报告的一半） */
  v_counts := jsonb_build_object(
    'classes',      coalesce(array_length(v_class_ids, 1), 0),
    'students',     (select count(*) from students where class_id = any (v_class_ids)),
    'assignments',  (select count(*) from assignments where class_id = any (v_class_ids)),
    'calls',        (select count(*) from calls where class_id = any (v_class_ids)),
    'examScores',   (select count(*) from exam_scores where class_id = any (v_class_ids)),
    'exams',        (select count(*) from exams where class_ids && v_class_ids),
    'classSubjects', (select count(*) from class_subjects where class_id = any (v_class_ids)),
    'classMembers', (select count(*) from class_members where class_id = any (v_class_ids)),
    'studentSubjects', (select count(*) from student_subjects
                         where student_id in (select id from students where class_id = any (v_class_ids))),
    'scheduleItems', (select count(*) from schedule_items
                       where class_id = any (v_class_ids)
                          or (scope = 'class' and class_id is null and teacher_id = any (v_teachers))),
    'classroomAccounts', (select count(*) from classroom_accounts where class_id = any (v_class_ids)),
    'classrooms',   (select count(*) from classrooms where class_id = any (v_class_ids)),
    'sharedFiles',  (select count(*) from shared_files
                      where coalesce(class_ids, '{}'::uuid[]) && v_class_ids
                         or class_id = any (v_class_ids)),
    'teacherRoles', (select count(*) from teacher_roles
                      where scope_id = p_grade_id
                         or (scope_type = 'class' and scope_id = any (v_class_ids))),
    'noticeTargets', (select count(*) from notice_targets where grade_id = p_grade_id));

  /* 教室端账号：**行会被 cascade 带走，`auth.users` 不会** ——
     服务端拿这份清单去删账号（否则留下"能登录但什么都读不到"的账号）。 */
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', ca.id::text, 'email', ca.email, 'name', ca.name)), '[]'::jsonb)
    into v_accounts
    from classroom_accounts ca where ca.class_id = any (v_class_ids);

  /* ---- ⑤-1 `exams` 孤儿（`class_ids` 是 uuid[]、建不了外键） ---- */
  delete from exams where class_ids && v_class_ids;
  get diagnostics n_exams = row_count;

  /* ---- ⑤-2 `shared_files`（第三个数组残留）：先减数组、再删变成无归属的行 ---- */
  select coalesce(array_agg(f.id), '{}'::uuid[]) into v_shared_ids
    from shared_files f
   where coalesce(f.class_ids, '{}'::uuid[]) && v_class_ids
      or f.class_id = any (v_class_ids);

  /*
   * ⚠️ 这里**不能用 `class_ids - v_class_ids`**：PostgreSQL 没有"数组相减"这个运算符
   *    （`operator does not exist: uuid[] - uuid[]`，PGlite 上实测建函数那一刻就断）。
   *    用 `array(select … where e <> all (v_class_ids))` 才是"把本届的班从数组里减掉"。
   */
  update shared_files f
     set class_ids = array(
           select e from unnest(coalesce(f.class_ids, '{}'::uuid[])) as e
            where e <> all (v_class_ids)
         )
   where f.id = any (v_shared_ids);
  get diagnostics n_trim = row_count;

  with del as (
    delete from shared_files f
     where f.id = any (v_shared_ids)
       and coalesce(array_length(coalesce(f.class_ids, '{}'::uuid[]), 1), 0) = 0
       and f.class_id is null
    returning f.storage_path
  )
  select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_storage from del;

  /* 老形状（`class_ids` 空、`class_id` 指着本届班）：行由 cascade 带走，**对象要记下来** */
  v_storage := v_storage || coalesce((
    select jsonb_agg(f.storage_path) from shared_files f
     where f.id = any (v_shared_ids)
       and f.class_id = any (v_class_ids)
       and coalesce(array_length(coalesce(f.class_ids, '{}'::uuid[]), 1), 0) = 0), '[]'::jsonb);
  n_files := jsonb_array_length(v_storage);

  /* ---- ⑤-3 `teacher_roles`（`scope_id` 没有外键）----
     🔴 **这就是 Q30 说的"撤回身份"那一步，而且是立刻撤**（不留宽限）。 */
  delete from teacher_roles
   where scope_id = p_grade_id
      or (scope_type = 'class' and scope_id = any (v_class_ids));
  get diagnostics n_roles = row_count;

  /* ---- ⑤-4 `schedule_items`（`class_id` 是 set null，不是 cascade）---- */
  delete from schedule_items where class_id = any (v_class_ids);
  get diagnostics n_sched = row_count;
  /* 顺手清掉"班级课表却没有班"的残骸（按定义就是垃圾行） */
  delete from schedule_items
   where scope = 'class' and class_id is null and teacher_id = any (v_teachers);
  get diagnostics n_tmp = row_count;
  n_sched := n_sched + n_tmp;

  /* ---- ⑤-5 级联：删 `classes` → 学生 / 作业 / 呼叫 / 分数 / 任教关系 /
            走班成员 / 选科 / 教室端行 / 排课归属 / 通知的年级收件人 一起走 ---- */
  delete from classes where grade_id = p_grade_id;
  get diagnostics n_classes = row_count;

  /* ---- ⑤-6 **最后**删 `grades`（顺序不能反）---- */
  delete from grades where id = p_grade_id;

  /* ---- 后置校验：逐项必须为 0（非 0 就把整件事回滚，绝不留下半截状态）---- */
  v_checks := jsonb_build_object(
    'grades',       (select count(*) from grades where id = p_grade_id),
    'classes',      (select count(*) from classes where grade_id = p_grade_id),
    'students',     (select count(*) from students where class_id = any (v_class_ids)),
    'assignments',  (select count(*) from assignments where class_id = any (v_class_ids)),
    'calls',        (select count(*) from calls where class_id = any (v_class_ids)),
    'examScores',   (select count(*) from exam_scores where class_id = any (v_class_ids)),
    'exams',        (select count(*) from exams where class_ids && v_class_ids),
    'teacherRoles', (select count(*) from teacher_roles
                      where scope_id = p_grade_id
                         or (scope_type = 'class' and scope_id = any (v_class_ids))),
    'classSubjects', (select count(*) from class_subjects where class_id = any (v_class_ids)),
    'classMembers', (select count(*) from class_members where class_id = any (v_class_ids)),
    'studentSubjects', (select count(*) from student_subjects where student_id in (select id from students where class_id = any (v_class_ids))),
    'scheduleItems', (select count(*) from schedule_items
                       where class_id = any (v_class_ids)
                          or (scope = 'class' and class_id is null and teacher_id = any (v_teachers))),
    'classroomAccounts', (select count(*) from classroom_accounts where class_id = any (v_class_ids)),
    'classrooms',   (select count(*) from classrooms where class_id = any (v_class_ids)),
    'sharedFiles',  (select count(*) from shared_files
                      where coalesce(class_ids, '{}'::uuid[]) && v_class_ids
                         or class_id = any (v_class_ids)),
    'noticeTargets', (select count(*) from notice_targets where grade_id = p_grade_id));

  select string_agg(format('%s=%s', k, v), '、')
    into v_bad
    from jsonb_each_text(v_checks) as t(k, v)
   where v <> '0';
  if v_bad is not null then
    raise exception '清残留校验没过（%）—— 整件事已经回滚，这个年级一个字节都没删', v_bad;
  end if;

  v_report := jsonb_build_object(
    'gradeId',   p_grade_id,
    'gradeName', v_full,
    'cohort',    v_cohort,
    'confirmedName', btrim(p_confirm_name),
    'deletedAt', now(),
    'counts',    v_counts,
    'deleted',   jsonb_build_object(
      'classes', n_classes, 'exams', n_exams, 'teacherRoles', n_roles,
      'scheduleItems', n_sched, 'sharedFilesTrimmed', n_trim,
      'sharedFilesDeletedOrOrphaned', n_files),
    'checks',    v_checks,
    'classIds',  to_jsonb(v_class_ids));

  update grade_removals
     set deleted_at = now(), deleted_by = p_actor, report = v_report, storage_paths = v_storage
   where id = v_rec.id;

  return jsonb_build_object(
    'ok', true, 'alreadyDeleted', false, 'report', v_report,
    'storagePaths', v_storage, 'classroomAccounts', v_accounts);
end $$;

-- -------- 29.8 权限：判据给 authenticated，**写入口只有服务端** --------
revoke all on function public.can_promote_grades_for(uuid) from public, anon, authenticated;
revoke all on function public.can_delete_grade_for(uuid, uuid) from public, anon, authenticated;
revoke all on function public.promote_grades(uuid) from public, anon, authenticated;
revoke all on function public.grade_backup(uuid, uuid) from public, anon, authenticated;
revoke all on function public.grade_backup_mail(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.grade_delete(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.grade_backup_payload(uuid, uuid) from public, anon, authenticated;
revoke all on function public.grade_backup_by_token(text) from public, anon, authenticated;
revoke all on function public.grade_backup_payload_json(uuid) from public, anon, authenticated;

grant execute on function public.academic_year_name_of(date) to authenticated;
grant execute on function public.current_academic_year() to authenticated;
grant execute on function public.grade_full_name(uuid) to authenticated;
grant execute on function public.can_promote_grades() to authenticated;
grant execute on function public.can_delete_grade(uuid) to authenticated;
grant execute on function public.promotion_overview() to authenticated;
revoke all on function public.promotion_overview() from anon;

-- -------- 29.9 RLS：两张新表**对 anon / authenticated 一个权限都不给** --------
alter table grade_promotions enable row level security;
alter table grade_removals  enable row level security;
revoke all on grade_promotions, grade_removals from public, anon, authenticated;

-- -------- 29.10 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 提档 **幂等**（跑两遍：第二遍 `alreadyPromoted=true`、`promoted=0`）：
--  -- select public.promote_grades('<超管的 teacher id>');
--  -- select public.promote_grades('<超管的 teacher id>');
--
--  ② 提档 **只改 `stage`**（班级 / 走班班的 `grade_id` 前后逐字相同）：
--  -- select c.id, c.grade_id from classes c join grades g on g.id = c.grade_id order by 1;
--  -- select public.promote_grades('<超管的 teacher id>');   -- 第二次：什么都没改
--  -- select c.id, c.grade_id from classes c join grades g on g.id = c.grade_id order by 1;
--
--  ③ 提档 **不撤回任何身份**（前后行数完全相等）：
--  -- select (select count(*) from teacher_roles) as 身份行, (select count(*) from class_subjects) as 任教行;
--
--  ④ **备份没发出 = 删不了**（`mail_ok=false` 时 `can_delete_grade` 必须是 false）：
--  -- select public.can_delete_grade('<某个高三的 grade id>');      -- 期望 false
--  -- select mail_ok from grade_removals where grade_id = '<高三 id>';  -- 期望 false
--
--  ⑤ **输错全名 = 删不了**：
--  -- select public.grade_delete('<超管的 teacher id>', '<高三 id>', '高三');
--  -- 期望：报「年级全名不对 —— 要**逐字**输入「高三（2024 级）」才放行」
--
--  ⑥ **非超管 = 被拒**（拿教务处的 id 调用那一句，必须报"只有最高管理员能做"）
--
--  ⑦ 删完 **清点表逐项 = 0**（每一项都是一条能跑的查询；`<班 id 数组>` 从
--     `grade_removals.report -> 'classIds'` 里取，或直接写死删除前记下来的那几个 id）：
--  -- select '孤儿 exams',        count(*) from exams            where class_ids && '<班 id 数组>'::uuid[];
--  -- select '悬空 teacher_roles', count(*) from teacher_roles    where scope_id = '<年级 id>'
--  --        or (scope_type = 'class' and scope_id = any('<班 id 数组>'::uuid[]));
--  -- select '悬空 schedule_items', count(*) from schedule_items   where class_id = any('<班 id 数组>'::uuid[])
--  --        or (scope = 'class' and class_id is null);
--  -- select '教室端行',            count(*) from classroom_accounts where class_id = any('<班 id 数组>'::uuid[]);
--  -- select '残留 shared_files',   count(*) from shared_files     where class_ids && '<班 id 数组>'::uuid[];
--  -- select '班级',                count(*) from classes          where grade_id = '<年级 id>';
--  -- select '年级',                count(*) from grades           where id = '<年级 id>';
--  -- select '学生',                count(*) from students         where class_id = any('<班 id 数组>'::uuid[]);
--  -- select '作业',                count(*) from assignments      where class_id = any('<班 id 数组>'::uuid[]);
--  -- select '呼叫',                count(*) from calls            where class_id = any('<班 id 数组>'::uuid[]);
--  -- select '考试分数行',          count(*) from exam_scores      where class_id = any('<班 id 数组>'::uuid[]);
--  -- select '通知的年级收件人',    count(*) from notice_targets   where grade_id = '<年级 id>';
--
--  ⑧ **删除幂等**（对同一个已删年级再删一次：`alreadyDeleted=true`、不改动任何东西）：
--  -- select public.grade_delete('<超管的 teacher id>', '<高三 id>', '高三（2024 级）');
--
--  ⑨ 两张新表**谁都读不到**（期望两条都是 0 行 / 775 权限不足）：
--  -- select * from grade_promotions;   -- 以 authenticated 身份跑
--  -- select * from grade_removals;     -- 以 authenticated 身份跑
--
--  ⑩ 写入口**只有服务端能调**（四条都要 42501）：
--  -- select public.promote_grades('00000000-0000-0000-0000-000000000000');
--  -- select public.grade_backup('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');
--  -- select public.grade_delete('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '高一');
--  -- select public.grade_backup_by_token('bk000000x000000x000000x000000x000000');

-- ============================================================
--  31. 统一模型改造（P5，2026-10-03）🔴 **风险最高的一期**
--      —— 行政班与走班班**同一张表**（Q21 = A）之后，读取路径与写判据要跟着改
-- ------------------------------------------------------------
--  ⚠️ §27 只补了 `classes.kind` / `class_type` / `stream_key` 三列，
--     **P5 整期没做**（`选科走班实施计划.md:604`）。本段补上 P5 剩下的两件事：
--       ① `assignments.class_id` 允许为空（走班作业可能不属于单一行政班）；
--       ② 作业的写判据要能容纳"未归属（走班）"这类行 —— 否则建不出来（§2.17 第 2 条）。
--
--  🔴 **本段为什么单列一节、而不回填进 §16.3**：
--     `schema.sql` 是一条**顺序执行**的流水线，`create policy` 与 SQL 函数体**当场解析名字**。
--     §16 在 §31 之前已经跑过，所以"改策略"这件事必须在**后面**再收一次口 ——
--     这与 §17 / §19 / §21 收紧教室端那条线的做法完全一样（同一个文件里可以有多次 `drop policy`）。
--
--  🔴 **本段破了"能不改 schema 就不改"这一条**（`选科走班实施计划.md` P5 的
--     「会碰哪些不变量」已登记这次例外）：`assignments.class_id` 的 `not null` 被拿掉了。
--     理由：走班作业的归属是**走班班那一行**（`classes.kind = 'stream'`），
--     而"不属于任何班"的作业（还没定归属）必须能存在 —— 这就是 P5 的验收第 5 条。
--     代价与回退见 §31.4。
-- ============================================================

-- -------- 31.1 `classes.kind` 的读取纪律（写在这里，代码在 `lib/pick.ts`）--------
--  `kind` 有数据库默认值 `'admin'`（§27.2），所以**没判 kind 的老读取点行为不变**。
--  ⚠️ 但它也可能**因此看不见走班班** —— 属于"静默漏数据"那一类（§2.10 成本 4）。
--  读取纪律（一句话）：**读 `classes` 的每一处都要回答"这里要不要按 kind 收口"**，
--  答案与逐处清单见 `功能设计与不变量.md` §三十一。
--  ⚠️ 数据库层**不加**任何按 kind 的读策略：`visible_class_ids()` 一次算出"哪些班看得见"，
--     行政班与走班班走**同一支判据**（任课老师那一支读 `class_subjects`，
--     而走班班的任教关系在 P7 自动补进同一张表）—— 加第二处判据 = 两个判定入口。
--
--  🔴 「谁能建 / 谁能改一个走班班」**不需要新判据**（已逐条核过，结论写在这里免得后人再发明一次）：
--     · 建：`classes_insert` 判 `teacher_id = 我` 且
--       （`is_school_admin()` = 超管 + 教务处 ∪ `grade_head` ∪ `head_teacher` ∪ `owns_class`），
--       走班班只多出 `kind='stream'` 一列，**照旧成立**（新班还没有 `grade_id`，所以只能判到身份那一档）；
--     · 改：`classes_update` 判 `can_manage_class(id) or owns_class(id)` ——
--       `can_manage_class_for` 的"年级主任"那一支是
--       `r.scope_id = (select c.grade_id from classes c where c.id = p_class_id)`，
--       **它按 `grade_id` 取，与 `kind` 无关 → 走班班天然复用**（正是 §2.17 第 1 条修订口径）；
--       "科任老师只在自己教的那个走班班上能改"落在 `can_grade_subject` 的 `teaches_subject_for` 上，也在。
--     · 删：同"改"。
--     所以 `can_manage_stream_class` 这个名字**故意不建**：建了就是同一件事的第二个判定入口，
--     而且两条判据一旦不一致就会打架（§十 的教训）。逐处核对清单见 `功能设计与不变量.md` §三十一。

-- -------- 31.2 🔴 `assignments.class_id` 允许为空（**幂等**）--------
--  ✅ **只需要一句，而且它天生幂等**：`drop constraint if exists … not null` ——
--     第一次真的去掉 `assignments_class_id_not_null`，之后每次都是 no-op。
--     PostgreSQL 的列级 `not null` 在 `pg_constraint` 里就是一条名为
--     `<表>_<列>_not_null` 的 check（`contype = 'c'`），所以这一句就是它。
alter table assignments drop constraint if exists assignments_class_id_not_null;

--  ⚠️ **不要再补一条 `check (class_id is null or exists (select 1 from classes …))`** ——
--     试过，PostgreSQL 直接回 `ERROR: cannot use subquery in check constraint`（CHECK 里不许有子查询）。
--     而"指向不存在的班"这件事**本来就由外键管住**（`class_id uuid references classes (id)`），
--     唯一的新增空间是"多了一个 null"，那正是这一期要的。所以这里**不需要**新约束。

--  自检（**幂等**：跑两遍，`not_null` 必须是 false；第二遍不能报 42710/23514）：
--  -- select a.attnotnull
--  --   from pg_attribute a
--  --  where a.attrelid = 'assignments'::regclass and a.attname = 'class_id';
--  -- select conname from pg_constraint
--  --  where conrelid = 'assignments'::regclass and contype = 'c' order by 1;

-- -------- 31.3 作业的写判据：**多一支"未归属（走班）"** --------
--  §2.17 第 2 条的正面解决：`assignments_insert/update` 原来只认
--  `can_grade_subject(class_id, …)` —— 而 `class_id` 为空时那个判据恒假
--  （`teaches_subject_for` 会拿 null 去比一个 uuid，比不中）→ **未归属的作业一行都建不出来**。
--
--  口径（**想清楚才写的，不是顺手放宽**）：
--   · `class_id` 有值 → 走**老判据一个字不改**：`super/admin` 兜底 + 本班本科研课老师。
--     走班作业挂走班班那一行（`kind='stream'`），所以本班本科 = 走班班的任教关系（P7 自动补）；
--   · `class_id` 为空（空串也当空 —— 前端"未归属"的写法，见 `remote.ts` 的 `assignmentToRow`）
--     → **`super/admin` ∪ "这条 INSERT 的 `teacher_id` 恰好是我自己"**。
--     刻意**不**放宽成"任何老师都能把未归属的作业挂到别人名下"：
--     那种作业没有任何班级能让别人看得见（读策略里"看得见这个班"那一支对 null 恒假），
--     放宽的结果是"建了但只有自己看得见"，没有收益、只是多一个说不清的写入口。
--     ⚠️ 于是**三条写策略的合取**收口成：未归属的作业 = 「我建的」——
--       `assignments_insert` 的 `teacher_id = auth.uid()` 与 `assignments_update` 的
--       `using`（要能选中那一行）都还在，所以 `p_uid` 只会在"是我自己"时才有意义。
--
--  ⚠️ `coalesce(btrim(p_class_id::text), '') = ''` 同时覆盖 `null` 与空串两种写法 ——
--     "没有归属"这件事**只能有一个判据**，所以下面两个函数都走它。
create or replace function public.assignment_unassigned(p_class_id uuid)
returns boolean
language sql
immutable
as $$ select coalesce(btrim(p_class_id::text), '') = '' $$;

create or replace function public.assignments_write_ok_for(
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
  select case
    /* 未归属：校级兜底 · **或"这条档案的建档人就是我自己"**（由调用方的策略把 `teacher_id` 钉死） */
    when public.assignment_unassigned(p_class_id) then
      public.is_school_admin_for(p_uid) or p_uid is not null
    else public.can_grade_subject_for(p_uid, p_class_id, p_subject_code, p_subject)
  end;
$$;

--  `_for` 变体接受任意 uid（"以任意人身份问权限"）→ **一律 revoke**（§16.2 / §27.12 的纪律）。
--  ⚠️ 两个名字**都要 revoke**：`revoke … on function f(uuid)` 只撤那一个签名。
revoke all on function public.assignment_unassigned(uuid) from public, anon, authenticated;
revoke all on function public.assignments_write_ok_for(uuid, uuid, text, text) from public, anon, authenticated;

--  裸版：给策略用（`auth.uid()` 由数据库自己取，前端插不上手）。
--  ⚠️ 与 `can_grade_subject` 并列、**不替换它** —— 后者是"能不能改这个班的这一科"，
--     它的签名与语义一个字都没改（I47 的入参形状不变）。
create or replace function public.assignments_write_ok(
  p_class_id uuid,
  p_subject_code text,
  p_subject text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.assignments_write_ok_for(auth.uid(), p_class_id, p_subject_code, p_subject) $$;

grant execute on function public.assignments_write_ok(uuid, text, text) to authenticated;
revoke all on function public.assignments_write_ok(uuid, text, text) from anon;

-- ---------- 31.3.1 重建三条写策略（`drop policy` 在前，`create policy` 在后）----------
--  ⚠️ 为什么"先 drop 后 create"在这里是可以的：策略判据是**逐条求值**的，
--     删掉旧的那一条的**同一瞬间**新的一条还没建 —— 中间态是"没有这一条策略"，
--     也就是**更严**（INSERT / UPDATE 会被 RLS 直接拒），不是"更宽"。
--     §16.3.0 里那句"先建新的再 drop 旧的"说的是**同一批策略之间**的可见量对照，
--     与这里"换掉一条判据"是两件事 —— 而且 `create policy` **改不了已存在的策略**，
--     必须 drop 才能重建（`create or replace` 对 policy 不存在）。
drop policy if exists assignments_insert on assignments;
create policy assignments_insert on assignments for insert to authenticated
  with check (
    teacher_id = auth.uid()
    and assignments_write_ok(class_id, subject_code, subject)
  );

drop policy if exists assignments_update on assignments;
create policy assignments_update on assignments for update to authenticated
  using (assignments_write_ok(class_id, subject_code, subject))
  with check (assignments_write_ok(class_id, subject_code, subject));

--  删：口径不变（自己建的 · 管得着这个班 · 在本班教这一科）——
--  `can_manage_class(null)` 与 `teaches_subject(null, …)` 都恒假，所以"自己建的"那一支
--  独自兜住未归属的行，正是要的结果。**这一条一个字没改**，只是挨着上面两条写明它已经被核过。
--  （`rls-checks.mjs` 第 31 节会断言：未归属的作业，建档人能删、别人删不掉。）

-- -------- 31.4 回退 SQL（出问题时用；**与正向一起写、一起测**）--------
--  ① 把未归属（`class_id is null`）的作业先挂到一个班里或删掉 —— 回退 `not null` 需要它；
--  -- select id, title from assignments where class_id is null;
--  -- update assignments set class_id = '<某个班 id>' where class_id is null;
--  -- delete from assignments where class_id is null;
--  ② 去掉"未归属"那一支并恢复两条写策略（删除策略本来就没改，不用回退）：
--  -- drop policy if exists assignments_insert on assignments;
--  -- create policy assignments_insert on assignments for insert to authenticated
--  --   with check (teacher_id = auth.uid() and can_grade_subject(class_id, subject_code, subject));
--  -- drop policy if exists assignments_update on assignments;
--  -- create policy assignments_update on assignments for update to authenticated
--  --   using (can_grade_subject(class_id, subject_code, subject))
--  --   with check (can_grade_subject(class_id, subject_code, subject));
--  -- alter table assignments add constraint assignments_class_id_not_null
--  --   check (class_id is not null) not valid;   -- 再加 `validate constraint` 收口--  ③ ⚠️ **回退之后凡是建过"未归属作业"的库必须回头看一遍**：那些行会立刻违反 `not null`，
--     所以第 ① 步不是可选项（这就是"破坏性迁移要单独一步 + 回退 SQL"的意思）。
-- ============================================================

-- ============================================================
--  32. 走班班（P7，2026-10-04）—— 生成 + 分配老师 + `can_stream` 废弃
-- ============================================================
--  这一节只做三件事，每一件都对应 `选科走班实施计划.md` P7 的一段：
--    ① 🔑 **生成走班班**（Q7 = B：系统给建议 → **教导处确认后才建**，一个事务）；
--    ② 🔑 **分配走班班老师**（Q19 = A：**自动补 `class_subjects`** ——
--       不补的话那位老师建作业会被权限层**静默拒掉**，见 §31.3 的 `assignments_write_ok`）；
--    ③ `subjects.can_stream` **废弃**（Q24 = B：走班四科写死在代码里）。
--
--  🔴 **不新建任何判据函数**：走班班是 `classes` 里 `kind='stream'` 的一行，
--     建 / 改 / 删天然复用 §31.1 核过的那几条（`classes_insert` / `can_manage_class_for`
--     的年级主任一支**按 `grade_id` 取、与 `kind` 无关**）。
--     `选科走班实施计划.md` P7 里那个 `can_manage_stream_class` 名字
--     **故意不存在**（§31.1 已经逐条核过）—— 建了就是同一件事的第二个判定入口。
--
--  🔴 **写入口的形状照 §30**：`service_role` + **显式 `p_actor`**，判据在函数体里问 `_for`；
--     `authenticated` **一个写权限都不给**（§27.12 / §29.8 同款）。

-- -------- 32.1 走班班的唯一键：`(grade_id, stream_key)`，只对走班班生效 --------
--  🔴 为什么是**部分唯一索引**而不是加一条 unique 约束：
--     `classes.stream_key` 对行政班恒为 `''`（§27.2 的默认值），而**行政班的班名可以重复**
--     （`classes` 没有任何班名唯一约束，§4.2.0 事实第 2 条）——
--     一条全表 unique 会把"两个班都叫高一(1)班"从"靠人"变成"建不出来"，
--     那是另一件事，不在这期的范围里。这里只钉住**走班班**：
--     同一个年级里，同一个 `stream_key` 只能有一个走班班。
--  ⚠️ 幂等：`create unique index if not exists`；已存在同名脏数据时会**直接失败并回滚整份脚本**
--     （不会留下半截状态），查重 SQL 见 §32.7。
create unique index if not exists classes_stream_key_uniq
  on classes (grade_id, stream_key)
  where kind = 'stream' and stream_key <> '';

-- -------- 32.2 🔑 生成走班班（**一个事务**：先校验完，再碰任何一张表）--------
--  为什么是"服务端算 + 库只落地"：
--    · 算法（走班科目怎么算、差 2 门的学生进两个班）是**纯逻辑**，
--      唯一实现在 `app/src/lib/stream.ts` 的 `planStreamClasses()` ——
--      `grade-checks.mjs` 直接 import 它跑真断言；
--      **不在 SQL 里再写一份**（那就是同一件事两个判定入口，本项目最贵的一类坑）。
--    · 库里这一层的职责是**形状与完整性**：班级存在、学生在册、科目在四科里、
--      **同一个学生不能在同一科上被塞进两个走班班**（漏一条就是"他那一科没有课上"）。
--
--  入参形状（服务端已经把"建议"摊成这个样子）：
--    p_groups = [{ "stream_key": "chemistry+geography",
--                  "name": "走班班-化学地理",
--                  "subjects": ["chemistry", "geography"],
--                  "class_id": null | "<已有的走班班 id>",
--                  "student_ids": ["…", …] }, …]
--
--  🔴 **确认是必经**（Q7 = B）：这个函数**不会**被页面自动调用 —— 只有教导处点了
--     「确认生成」才会打过来；它**不删**任何走班班（老师的调课 / 改名不会被一次重算抹掉）。
drop function if exists public.generate_stream_classes(uuid, jsonb);
create or replace function public.generate_stream_classes(p_actor uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r           record;
  e           record;
  v_n         int := 0;
  v_g         int := 0;
  v_s         int := 0;
  v_total     int := 0;
  v_class     uuid;
  v_grade     uuid;
  v_teacher   uuid;
  v_key       text;
  v_name      text;
  v_cid       text;
  v_cid_uuid  uuid;
  v_other     uuid;
  /** 同一科进两个班时那一科的**科目代码**（text —— 与 `v_other` 的语义不同，所以是两个变量） */
  v_dup       text;
  v_subs      jsonb;
  v_stu       jsonb;
  v_classes   jsonb := '[]'::jsonb;
  v_subjects  text[] := array['chemistry', 'biology', 'politics', 'geography'];
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '要生成的是"一数组的走班班"，收到的不是数组';
  end if;

  /*
   * 🔴 **上限与空表先判**（在逐行校验之前）—— 与 `bulk_write_class_subjects()` 同款：
   *    否则"第 1 行的班级不存在"会盖住真正的原因（这里真正的原因往往是"没有要走班的人"）。
   */
  if jsonb_array_length(p_rows) = 0 then
    raise exception '没有要走班的组合 —— 这个年级的选科里没有人在走班（先确认班型与选科都采完了）';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception '一次最多生成 200 个走班班，这次有 % 个', jsonb_array_length(p_rows);
  end if;

  /*
   * 🔴 **请求内**先查一遍"同一个学生在同一科上进两组"。
   *    ⚠️ 顺序很要紧：只靠 ① 里那句**查库**的判断，这一批**新来的**行彼此是看不见的
   *       （都还没写进去），于是"同一科进两个班"会被静默放过（实测踩过）。
   *       所以：**先比这一批自己**（这一句），再比库里的（① 里那句），两处都要有。
   *    ⚠️ 写法上踩过两个坑，都写在这里（**报出来的错与真正的原因完全无关**，最难查）：
   *       ① 数组元素是**字符串** → 一律 `#>> '{}'` 取，别写 `->>`（那是取对象的字段）；
   *       ② 这个检查的结论是**科目代码**，必须收进 `v_dup`（**text**）——
   *          收进 `v_other`（**uuid**，另一处在用）会得到
   *          `invalid input syntax for type uuid: "chemistry"`。
   *          一个变量一种语义，连"临时收一下"都不行。
   */
  with flat as (
    select i.ord                                   as ord,
           (i.value ->> 'stream_key')              as skey,
           s.subj                                  as subj,
           st.sid                                  as sid
      from jsonb_array_elements(p_rows) with ordinality as i(value, ord)
      cross join jsonb_array_elements_text(i.value -> 'subjects')    as s(subj)
      cross join jsonb_array_elements_text(i.value -> 'student_ids') as st(sid)
  )
  select a.subj into v_dup
    from flat a
    join flat b on a.subj = b.subj and a.sid = b.sid and a.ord < b.ord
   where a.skey <> b.skey
   limit 1;
  if v_dup is not null then
    raise exception '这一批里有学生在**同一科**上进两个走班班（科目 %）—— 同一科只许进一个班', v_dup;
  end if;

  /* ① 逐组校验（这一圈里**一行都不写**） */
  for r in select value as g from jsonb_array_elements(p_rows) loop
    v_g := v_g + 1;
    v_key := btrim(coalesce(r.g ->> 'stream_key', ''));
    v_name := btrim(coalesce(r.g ->> 'name', ''));
    v_subs := coalesce(r.g -> 'subjects', '[]'::jsonb);
    v_stu := coalesce(r.g -> 'student_ids', '[]'::jsonb);
    v_cid := nullif(btrim(coalesce(r.g ->> 'class_id', '')), '');
    v_cid_uuid := null;
    if v_cid is not null then v_cid_uuid := v_cid::uuid; end if;
    if v_key = '' then
      raise exception '第 % 组没有 stream_key（走班班的组合标识）', v_g;
    end if;
    if v_name = '' then
      raise exception '第 % 组没有名字', v_g;
    end if;
    if jsonb_typeof(v_subs) <> 'array' or jsonb_array_length(v_subs) = 0 then
      raise exception '第 % 组没有指定走班科目', v_g;
    end if;
    for e in select value as s from jsonb_array_elements(v_subs) loop
      if not (btrim(e.s #>> '{}') = any (v_subjects)) then
        raise exception '第 % 组的科目「%」不在走班四科里（化学 / 生物 / 政治 / 地理）', v_g, e.s #>> '{}';
      end if;
    end loop;
    if jsonb_typeof(v_stu) <> 'array' or jsonb_array_length(v_stu) = 0 then
      raise exception '第 % 组一个人都没有 —— 空走班班不建（人数 = 1 的也要人来判断开不开）', v_g;
    end if;
    /*
     * ⚠️ 这里**不**逐组把第一个学生 cast 成 uuid 再查（`(v_stu -> 0) #>> '{}'`）：
     *    上一次这么写时，PGlite 上冒出一句与真正原因无关的
     *    `invalid input syntax for type uuid: "chemistry"`（而且把一个好端端的校验也带红了）。
     *    学生存不存在由下面那句**集合式**的 exists 兜住 —— 它只比 `students`，一个 cast 都不做。
     */
    if not exists (
      select 1
        from students s
       where s.id::text in (select sid from jsonb_array_elements_text(v_stu) as sid)
    ) then
      raise exception '第 % 组有学生在库里找不到', v_g;
    end if;

    /*
     * 🔴 同一个学生在**同一科**上不许属于两个走班班：那意味着他被排了两次、必然撞车。
     *    ⚠️ 重跑本函数时这一条**必须排除"本组自己那个班"**：
     *       走班班的身份是 `(年级, stream_key)`（§32.1），所以判据是
     *       **`c.stream_key = v_key` 就跳过** —— 而不是看请求里带没带 `class_id`
     *       （重跑时前端不带 `class_id`，只看它会把"这个组自己"判成冲突 → **假红**，实测踩过）。
     *    ⚠️ 这里刻意写成**一句 set-based 的 `exists`**，不写"循环 + record"：
     *       `for e in select value from jsonb_array_elements(…)` 再引 `e.value` 在 PL/pgSQL 里会
     *       撞上"变量 / 列"歧义（`42702` ambiguous），而改成 `as s` 再 `e.s` 更是**恒为 null、
     *       quietly 放过**（PGlite 实测踩过两次）—— 数组元素是**字符串**，不是对象。
     */
    select cm.class_id into v_other
      from class_members cm
      join classes c on c.id = cm.class_id
     where c.kind = 'stream'
       and c.stream_key <> ''
       and c.stream_key <> v_key
       and (v_cid_uuid is null or cm.class_id <> v_cid_uuid)
       and exists (
         select 1
           from unnest(string_to_array(c.stream_key, '+')) a
           join unnest(string_to_array(v_key, '+')) b on a = b
       )
       and cm.student_id in (
         select (elem.value #>> '{}')::uuid from jsonb_array_elements(v_stu) as elem(value)
       )
     limit 1;
    if v_other is not null then
      raise exception '第 % 组：有一个学生已经在另一个走班班里上同一科了（走班班 %）—— 同一科不许进两个班', v_g, v_other;
    end if;
  end loop;

  /* ② 一个事务、一次写完 */
  for r in select value as g from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_class := null;
    v_key := btrim(coalesce(r.g ->> 'stream_key', ''));
    v_stu := coalesce(r.g -> 'student_ids', '[]'::jsonb);

    /*
     * 这个组的年级：从**第一个学生**身上取（走班班属于学生的年级；§27.1 的届）。
     * ⚠️ 一次取到，下面"认回已有的班"与"新建"都用它 —— 认回时**必须带年级**，
     *    否则两个年级的同名组合会互相抢（`stream_key` 只在年级内唯一，§32.1）。
     */
    select c.grade_id, c.teacher_id into v_grade, v_teacher
      from students s join classes c on c.id = s.class_id
     where s.id = ((v_stu -> 0) #>> '{}')::uuid;
    if v_grade is null then
      raise exception '第 % 组的学生没有挂到任何年级上', v_n;
    end if;

    select nullif(btrim(coalesce(r.g ->> 'class_id', '')), '')::uuid into v_class;
    if v_class is not null
       and not exists (select 1 from classes c where c.id = v_class and c.kind = 'stream') then
      v_class := null;
    end if;

    if v_class is null then
      /* 已有的走班班按 (年级, stream_key) 认回来 —— 认不出才新建（幂等：重跑不重复建） */
      select c.id into v_class
        from classes c
       where c.kind = 'stream'
         and c.grade_id = v_grade
         and c.stream_key = v_key
       order by c.created_at
       limit 1;
    end if;

    if v_class is null then
      insert into classes (teacher_id, name, grade, school_id, grade_id, kind, class_type, stream_key)
      values (coalesce(v_teacher, p_actor),
              btrim(r.g ->> 'name'),
              (select g.name from grades g where g.id = v_grade),
              (select g.school_id from grades g where g.id = v_grade),
              v_grade, 'stream', '', v_key)
      returning id into v_class;
    end if;

    /* 成员关系：**整组重算**（多对多；差 2 门的学生会同时出现在两个组里） */
    delete from class_members where class_id = v_class;
    insert into class_members (class_id, student_id)
    select v_class, sorted.x
      from (
        select distinct (elem.value #>> '{}')::uuid as x
          from jsonb_array_elements(v_stu) as elem(value)
      ) sorted;
    get diagnostics v_s = row_count;
    v_total := v_total + v_s;

    v_classes := v_classes || jsonb_build_object(
      'classId', v_class,
      'streamKey', v_key,
      'name', btrim(r.g ->> 'name'),
      'subjects', r.g -> 'subjects',
      'members', v_s
    );
  end loop;

  return jsonb_build_object('ok', true, 'classes', v_classes, 'created', v_n, 'members', v_total);
end $$;

-- -------- 32.3 🔑 分配走班班老师（**自动补 `class_subjects`**，Q19 = A）--------
--  为什么必须补：那位老师紧接着就要在这个走班班建作业，而 `assignments_write_ok`
--  （§31.3）在 `class_id` 有值时走的是 `can_grade_subject` → `teaches_subject_for`
--  —— 它读的就是 `class_subjects`。**不补 = 建作业被 RLS 静默拒掉**（返回 0 行、不报错），
--  而"不报错但就是不对"正是这个项目反复栽的那一类（§三.5）。
--
--  与"分配老师"**同一个事务**：老师与任课关系要么一起落，要么都不落。
--  走班班教哪几科从 `stream_key` 反查 —— ⚠️ 认不出来（老师手工改过名字 / 键）
--  就**显式报错**，不许拿别的科目顶上。
drop function if exists public.assign_stream_teacher(uuid, uuid, uuid);
create or replace function public.assign_stream_teacher(
  p_actor uuid,
  p_class_id uuid,
  p_teacher_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grade   uuid;
  v_key     text;
  v_name    text;
  v_kind    text;
  v_codes   text[];
  v_added   int := 0;
begin
  select c.grade_id, c.stream_key, c.name, c.kind
    into v_grade, v_key, v_name, v_kind
    from classes c where c.id = p_class_id;
  if v_grade is null and v_name is null then
    raise exception '这个走班班不存在';
  end if;
  if v_kind <> 'stream' then
    raise exception '这不是走班班（分配走班班老师只对 kind = stream 的班）';
  end if;
  if not public.can_manage_grade_setup_for(p_actor, v_grade) then
    raise exception '你没有分配这个年级走班班老师的权限（教务处 / 最高管理员 / 本年级的年级主任）';
  end if;
  if not exists (select 1 from teachers t where t.id = p_teacher_id) then
    raise exception '这位老师不存在';
  end if;

  v_codes := array(
    select x from unnest(string_to_array(coalesce(v_key, ''), '+')) x
     where x = any (array['chemistry', 'biology', 'politics', 'geography'])
  );
  if coalesce(array_length(v_codes, 1), 0) = 0 then
    raise exception '这个走班班认不出它教哪几科（stream_key 是「%」）—— 先把它的组合标识补对', coalesce(v_key, '');
  end if;

  /* ① 走班班这一行的"老师"（`classes.teacher_id`：它是"这个班的负责人"，与任教关系是两件事） */
  update classes set teacher_id = p_teacher_id where id = p_class_id;

  /* ② **自动补任教关系**：一门课一行 —— `can_grade_subject` 就是按 (班, 科目) 问的 */
  insert into class_subjects (class_id, subject, teacher_id, subject_code)
  select p_class_id, s.name, p_teacher_id, s.code
    from subjects s
   where s.code = any (v_codes)
  on conflict (class_id, subject_code, teacher_id) do nothing;
  get diagnostics v_added = row_count;

  return jsonb_build_object('ok', true, 'classId', p_class_id, 'teacherId', p_teacher_id,
                            'subjects', to_jsonb(v_codes), 'added', v_added);
end $$;

-- -------- 32.4 权限：两个写入口**只有服务端能调**（§30 的形状，逐条对齐 §27.12）--------
--  ⚠️ 断言（跑完本段逐条验）：
--    ① 以 authenticated 身份 `select public.generate_stream_classes('[]')` → **42501**
--    ② 以 authenticated 身份 `select public.assign_stream_teacher(...)` → **42501**
--    ③ 以 service_role（属主）身份调、带显式 `p_actor` → 通（或报出那一组的人话）
--  🔴 **不加 grant**：`authenticated` 对 `class_members` / `class_subjects` 是零写权限的表（§27.8），
--     而这两个函数是 `security definer` —— grant 出去 = 任何登录者拿 anon key 就能批量建班、
--     改任教关系，并且绕过服务端的形状校验（§30.3 的三条理由一字不改地适用）。
revoke all on function public.generate_stream_classes(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.assign_stream_teacher(uuid, uuid, uuid) from public, anon, authenticated;

-- -------- 32.5 课表冲突要读的那两份数据（**读**，给前端算冲突；判据不在这里）--------
--  冲突算法**只有一处**（`app/src/lib/stream.ts` 的 `findScheduleConflicts()`），
--  三个排课入口（教师端日程表 / 批量粘贴 / 教室端粘贴）共用它 —— I16 的又一次现场。
--  它需要两份数据，而这两张表都是**读得宽**的（班主任 / 任课老师都要能看见自己班的）：
--    · 走班班的成员 → `class_members`（`class_members_read` 策略已经在 §27.8 给了；
--      ⚠️ 前端**懒加载**，不进 `loadSnapshot()`，老库没这张表时不崩 —— 见 `data/remote.ts`）；
--    · 走班班的任教关系 → 从 `class_members` 那一行自动补出来的 `class_subjects`
--      （`class_subjects_read` 在 §10 已经有了）。
--  所以本段**不新增读策略、也不新增读函数** —— 多一条就是同一份数据的第二个出口。

-- -------- 32.6 🔴 `subjects.can_stream` **废弃**（Q24 = B）--------
--  用户口径：走班四科（**含化学**）**写死在代码里**（`app/src/lib/stream.ts` 的
--  `STREAM_SUBJECT_CODES`），**不再读 `subjects.can_stream`**。
--
--  为什么是 **drop 列**而不是"留着 + 标注废弃"：
--    · 这一列**和代码里的四科常量说的是同一件事**（"哪几科能走班"），
--      留着它 = **一个字段两种语义来源**（§四的硬约束），而且它今天就是错的
--      （库里 `can_stream = true` 的是 生物 / 政治 / 地理 **3 科，漏了化学**，
--       而代码里是 4 科 → "两个真相"，下一轮谁读它谁就错）。
--    · `create table` 那一份**同时删列**（新库不建它）+ 这一句 `drop column`（老库删掉它），
--      `schema.sql` 幂等 → 两类库收敛到**同一个形状**（§一"schema 必须幂等"的要求）。
--    · 代价（如实登记）：**那一列的数据没了**。它是 `on conflict do nothing` 写进去的
--      恒定种子数据（三行 true、其余 false），不是学校录入的业务数据 ——
--      要恢复手工跑一次就行，恢复 SQL 见下面注释。
--  ⚠️ 顺序：**先改 `create table` 的列清单、再 drop** —— `create table if not exists`
--     对已存在的表不生效，所以两句都要在（缺一句就有一类库收敛不过去）。
alter table subjects drop column if exists can_stream;
--  自检（幂等：跑两遍，下面这条必须回 0 行）：
--  -- select column_name from information_schema.columns
--  --  where table_schema='public' and table_name='subjects' and column_name='can_stream';
--  回退（要恢复那一列时；**四科的真相仍在 `lib/stream.ts`，不要拿它当判据**）：
--  -- alter table subjects add column if not exists can_stream boolean not null default false;
--  -- update subjects set can_stream = true where code in ('biology','politics','geography');

-- -------- 32.7 核对（把下面整段粘进 SQL 编辑器）--------
--  ① 走班班的唯一键在不在（期望 1 行）：
--  -- select indexname from pg_indexes where tablename='classes' and indexname='classes_stream_key_uniq';
--  ② 建索引之前先查重（有重复时 `create unique index` 会直接失败、整份脚本回滚）：
--  -- select grade_id, stream_key, count(*) from classes
--  --  where kind='stream' and stream_key <> '' group by 1,2 having count(*) > 1;
--  ③ 走班班一览（**多对多**：同一个学生在两行里出现是正常的 —— 差 2 门）：
--  -- select c.name, c.stream_key, count(cm.student_id) as 人数
--  --   from classes c left join class_members cm on cm.class_id = c.id
--  --  where c.kind = 'stream' group by 1,2 order by 1;
--  -- select student_id, count(*) from class_members group by 1 having count(*) > 1;
--  ④ 每个走班班有没有老师、有没有任教关系（**两列都必须 > 0**，否则那位老师建不了作业）：
--  -- select c.name, (c.teacher_id is not null) as 有老师,
--  --        (select count(*) from class_subjects cs where cs.class_id = c.id) as 任教关系
--  --   from classes c where c.kind = 'stream' order by c.name;
--  ⑤ 两个写入口**没有**给 authenticated（期望 0 行）：
--  -- select p.proname from pg_proc p
--  --  where p.proname in ('generate_stream_classes','assign_stream_teacher')
--  --    and has_function_privilege('authenticated', p.oid, 'execute');
--  ⑥ `can_stream` 那一列没了（期望 0 行）：
--  -- select column_name from information_schema.columns
--  --  where table_schema='public' and table_name='subjects' and column_name='can_stream';
-- ============================================================
