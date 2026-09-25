-- ============================================================
--  树高教师平台 · 自检查询（supabase/自检.sql）
--  用途：跑完 supabase/schema.sql 之后，把这四段核对 SQL 粘进
--        Supabase SQL 编辑器，一段一段跑。
-- ============================================================
--
-- 【这是什么】
--   从 supabase/schema.sql 的 §12.5 / §13.5 / §15.4 / §16.6 四段
--   「自检 / 核对 SQL」**摘出来的便利副本**（另附 §15.5 的排名核对，见第 3 段）。
--   schema.sql 里这几段散落在文件各处，而且 §15.4 / §16.6 里有一部分是
--   `--` 注释状态 —— 没法整段复制出来直接跑。这份就是给"直接粘"用的。
--
-- 【⚠️ 权威源是 supabase/schema.sql，这一份是副本】
--   · 改了 schema.sql 里这四段中的任何一句，**必须回来同步这一份**；
--     两边不一致时，**以 schema.sql 为准**。
--   · 反过来：这份文件不被任何东西引用，跑不跑它都不影响建库 / 上线。
--   · 本副本摘录时 schema.sql 共 2352 行（2026-09-27 补了 §18 之后更长）；下面每段都标了来源行号。
--     schema 一改行号就会漂，对账请以段号（§12.5 等）为准。
--
-- 【⚠️ 跑之前必须先跑完整的 supabase/schema.sql】
--   这些查询用到 schema.sql 建出来的表 / 列 / 函数：
--     表：subjects / teachers / classes / students / assignments / calls /
--         classrooms / teacher_roles / class_subjects / classroom_accounts /
--         exams / exam_scores
--     函数：visible_class_ids_for() / can_view_all_subjects_for() /
--           teaches_subject_for() / can_manage_class_for() /
--           teaches_in_class_for() / is_school_admin_for() /
--           can_grade_subject_for() / **can_edit_exam_for()**
--   报错 `relation … does not exist` / `column … does not exist` /
--   `function … does not exist` 说明的是「schema.sql 还没跑完」，
--   **不是本校数据出了问题**。
--
-- 【怎么跑】
--   · 四段**互相独立**，可以一段一段跑（推荐），也可以整份粘进去一次跑完。
--   · 全部是**只读查询**：本文件里没有 insert / update / delete / create /
--     drop / grant / alter；也**没有 begin / commit**（不加事务 —— 你要逐段跑，
--     包在事务里反而容易把上一段的结果一起回滚掉）。
--     ✅ 2026-09-27 起**没有"照抄会报错"的地方了**：第 3 段 §15.4 ② 原来引用了一个
--     **故意没建**的函数（`can_edit_exam_for`），只能改写成等价版本；现在那个函数
--     已经建出来（schema.sql §15.2），本副本也改回**直接调真函数**。
--     为什么不建那个变体会出问题，见 schema.sql §18.1（一句话：
--     编辑器里 `auth.uid()` 是 NULL，"谁能改"这件事根本没法问）。
--   · 「应为0」是字面意思：**不为 0 = 发现了问题**。非 0 时不要改脚本去凑 0，
--     先看同一段里的明细查询，再按对应小节（§12.6 / §13.6 等）显式修数据。
--
-- 【本副本相对 schema.sql 改了什么】（除了排版，只有下面这几处）
--   ① 取消注释：§15.4 ①②、§16.6 ③④ 的查询在 schema.sql 里是 `--` 注释状态，
--      这里全部取消注释；**原有的说明性注释一条都没删**
--      （"为什么该是 0"这些话都留着）。
--   ② uuid 占位改成按姓名查（§13.5 ①②、§15.4 ②、§16.6 ①）：
--        schema.sql 原版：with me as (select '<要核对的老师 id>'::uuid as uid)
--        本副本：        with me as (select id as uid from teachers
--                                     where name = '示例教师' order by created_at, id limit 1)
--      为什么改：省得每次手填 uuid。原版那一行的**形状**保留在每一处的注释里，
--      想改回 uuid 写法就照那个形状抄。
--      🔴 `'示例教师'` **是占位符，不是真名**：本文件在公开仓库里，所以
--         **一律不写真人姓名**（原先这里写的是真实教师姓名，已移除）。
--         **跑之前把它换成你要核对的那位老师的姓名**，否则 CTE 是空集 → 假通过
--         （下面每一段开头的「【先跑这一条】人是谁」就是拦这个的）。
--      ⚠️ 风险：姓名打错 / 库里没有这个人 → CTE 是**空集** → 依赖它的那些
--      「应为0」会**假通过**（计数变 0 或全 NULL）。所以每段开头都放了一条
--      「【先跑这一条】」查询：确认人对了再往下跑。
--   ③ §16.6 ④ 的教室端 uuid：原版是 `'77777777-7777-7777-7777-777777777777'`
--      这个**假 uuid**（库里根本不存在 → 三个计数必然全 0 → 假通过）。
--      本副本改成从 classroom_accounts 里查真实账号，详见该处注释。
--   ④ 新增了 3 条「【先跑这一条】」查询 + 1 条 §15.5 排名核对
--      （§15.4 的注释里点名引用 §15.5）。
--      新增的都带 `★ 本副本新增` 标记，方便将来跟 schema.sql 对账时区分。
--   ⑤ 2026-09-27：§15.4 ② 从"等价改写版"改回**直接调 `can_edit_exam_for`**
--      （改写版的由来与"读串了列"那处分叉都写在 §15.4 ② 的注释里），
--      并新增 ②–B（判每一行自己的老师）与 ②–C（汇总「应为0」）——
--      A/B 两种问法放在一起看，才不会再把"别人的行 = false"读成权限收错了。
--
-- 【四段各自在验什么 / 期望看到什么】（详细版在每段开头）
--   §12.5  学科回填体检：字典外的学科字符串有没有漏在那儿（三项应全 0）
--   §13.5  读策略收窄之后「没人丢自己的数据」：逐行对照 + 汇总（自己建的却看不见 = 0）
--   §15.4  考试两张表与写判据：表 / 策略数量对不对，`can_edit_exam_for` 在真实数据上怎么判
--   §16.6  删旧策略前后：逐人可见量**两边必须逐行相同**，且该拒的确实被拒
-- ============================================================


-- ============================================================
--  第 1 段 · §12.5 自检：学科回填体检
--  来源：supabase/schema.sql 第 933-963 行（第 12 段「多学科 · 阶段 1」末尾）
--
--  在验什么：第 12 段给 assignments / teachers / class_subjects 加了
--    `subject_code` 这一列（新列才是判据），回填口径是「学科名与字典
--    subjects.name 去空白后**完全相同**才回填」。这段体检就是问：
--    还有哪些行**没填上**？
--  期望看到什么：
--    ① 三行**全是 0**（作业 / 教师 / 任课关系都没有缺代码的行）。
--       ⚠️ 「教师」那一项有个**合法的例外**（教室端账号），见本段末尾的说明。
--       有非 0 → 库里有"字典外的学科字符串"（例如写成「高中语文」）。
--       这时先看 ② 的明细，再按 §12.6 显式指派；**不要**改回填脚本去凑 0。
--    ② 上面全 0 时这条返回 **0 行**；有明细时看「学科名」列到底写成了什么。
--    ③ **15 行**（字典里的 15 个科目；`can_stream = true` 的是走班候选）。
--    ④ 每个学科名一行，「缺代码」列应当**全是 0**（与 ① 是同一件事的另一面）。
--  要改什么：**不用改**。本段没有 uuid 占位，直接跑。
--
--  ⚠️ 一个**合法的例外**，先知道免得白紧张：教室端账号也会有一条 teachers 行
--     （schema.sql §17 的说明：`handle_new_user` 触发器给**每个** auth 用户建 teachers 行；
--      建教室端账号时带的是 `{name, kind:'classroom'}`，**没有 subject_code**
--      —— 见 `app/functions/api/classroom-account.ts`），所以它的 primary_subject_code 永远是 null。
--      → ① 里「教师没有主学科」在**有教室端账号的库里通常是 1（有几个就几行）**，
--        ② 的明细里表现为 `来源=教师 / 学科名=物理（触发器兜底的显示名）/ 行数=N`。
--        那不是教师回填漏了，**也不用去补**（教室端账号本来就没有主学科）。
--      → 真正要盯的是「作业没有学科代码」「任课关系没有学科代码」这两项是不是 0。
-- ============================================================

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


-- ============================================================
--  第 2 段 · §13.5 核对：跑完第 13 段，先证明「没人丢自己的数据」
--  来源：supabase/schema.sql 第 1273-1319 行
--
--  在验什么：第 13 段重写了 assignments 的**读**策略（`assignments_visible`），
--    把"我这一科"也算了进去 —— 也就是说读的范围**被收窄**了。收窄就可能
--    有人看不见自己的东西，所以这里逐行核一遍。
--  期望看到什么：
--    ① 逐行对照里，**凡是 `是他建的 = true` 的行，`新_看得见` 必须是 true**；
--       `新_看得见 = false` 的行，都应当是"他自己没建、也不教这一科"的。
--       另外 `新 ≤ 旧` 必须处处成立（交集只会变小，不会多出来）。
--    ② 汇总四个数里最关键的是最后一个：
--       **`自己建的却看不见_应为0` 必须是 0**（不是 0 就是权限事故，别往下走）。
--       `被收窄` 可以有值（那正是这次收窄预期的效果），但要人工扫一遍
--       被收窄的是不是都属于"别人的班 + 别人教的科"。
--    ③ teacher_roles 里 super / admin 各有几个人，一眼看清。
--  要改什么：① ② 用的是"指定人"参数。本副本已把 uuid 改成按姓名查
--    （默认「示例教师」——**占位符**，跑前换成真名）—— 见下面【本副本的改动】。换人只改那个姓名。
--  ⚠️ 为什么不能直接写 auth.uid()：SQL 编辑器里没有登录态，auth.uid() 是 NULL，
--     会得到 0 = 0 的**假通过**。所以必须用 `_for` 变体指定人。
-- ============================================================

-- ★ 本副本新增：【先跑这一条】人是谁。
--   库里到底有哪些老师、id 分别是什么，先看一眼再往下跑（表很小，直接全列）。
--   schema.sql 里给的提示是 `select id, name from teachers;`，这里多带两列更好认。
--   ⚠️ 如果下面 ① ② 里 `me` 的姓名在结果里找不到 → CTE 是空集 →
--      `自己建的却看不见_应为0` 会**假通过**（0），别把假通过当通过。
select id, name, subject, primary_subject_code, created_at from teachers order by created_at, id;

--  ① 逐行对照（把 uuid 换成要核对的老师 id；教师 id 用 `select id, name from teachers;` 拿）
--     期望：**新_看得见 = false 的行，全部都是"他自己没建、也不教这一科"的**；
--           凡是 `teacher_id = 他自己` 的行，新_看得见必须是 true。
--
--  【本副本的改动】原版是写死 uuid：
--    with me as (select '<要核对的老师 id>'::uuid as uid)
--  这里改成按姓名查（默认核对「示例教师」——**占位符**，跑前换成真名）。换人：把 '示例教师' 改成别的姓名；
--  有重名时把 `limit 1` 换成明确的 `where id = '……'::uuid`，否则核的是"任意一个"同名的。
with me as (select id as uid from teachers where name = '示例教师' order by created_at, id limit 1)
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
--  【本副本的改动】同 ①，`me` 由写死 uuid 改成按姓名查（默认「示例教师」——占位符，跑前换成真名）。
with me as (select id as uid from teachers where name = '示例教师' order by created_at, id limit 1),
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


-- ============================================================
--  第 3 段 · §15.4 自检：考试（exams / exam_scores）建好了没 + 写判据怎么判
--  来源：supabase/schema.sql 第 1556-1575 行（§15.4）
--        另附 §15.5 的排名核对，第 1577-1596 行（§15.4 的注释点名引用它）
--
--  在验什么：
--    ① 考试那两张表有没有开 RLS、策略是不是都建出来了；
--    ② 写判据 `can_edit_exam_for()` 在**真实数据**上到底怎么判（谁能改哪一行）——
--       `can_edit_exam()` 是它读 `auth.uid()` 的薄包装，而编辑器里没有登录态
--       （`auth.uid()` = NULL）→ 裸版对**任何人**都返回 false，所以要核对只能用 `_for` 版
--       （schema.sql §18.1：这就是"每个判据都要有 `_for` 变体"的理由）；
--    ③ （附 §15.5）年级排名 / 班级排名算出来长什么样 —— 没有额外的表，
--       就靠那一条查询（判据是 paper_key + subject_code + grade + exam_date 四样相同）。
--  期望看到什么：
--    ① 第一条：两行，`rowsecurity` 都是 `t`；
--       第二条：**一共 4 行** —— exams 2 条（visible=SELECT / write=ALL）、
--       exam_scores 2 条（同）。少一条都说明第 15 段没跑完。
--    ②–A：`me` 自己任教的那几行 `核对对象能改这一行 = true`；**别人的行 = false**
--       （那不是 bug：见下面那段"读串了列"的说明）。
--       ②–B：换一种问法（判每一行自己的老师）→ **每一行都是 true**，汇总「应为0」= 0。
--    ③ 每个学生一行，班内/年级两个名次；并列时 rank() 会跳号（1,1,3），
--       那是 rank 的定义，不是 bug。
--  要改什么：② 的姓名（默认「示例教师」——占位符，跑前换成真名）；③ 的 paper_key（默认 '物理练习8'）。
--  ✅ 2026-09-27 起 ② 直接调**真函数**：`can_edit_exam_for` 已在 schema.sql §15.2 建出来
--     （定义在薄包装 `can_edit_exam` 之前）。此前它**故意没有建**，本副本只能改成
--     `is_school_admin_for(...) or teaches_subject_for(...)` 的等价版本 —— 那段历史留在
--     下面 ② 的注释里（**别再改回去**：等价改写 = 判据多一处手抄，一改就与数据库分叉）。
-- ============================================================

--  ① 两张表都开了 RLS、策略数量对不对
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename in ('exams','exam_scores');
select tablename, policyname, cmd from pg_policies
 where schemaname = 'public' and tablename in ('exams','exam_scores') order by 1,2;
--  期望：exams 2 条（visible=SELECT / write=ALL）、exam_scores 2 条，共 4 条。

-- ★ 本副本新增：【先跑这一条】人是谁（② 要用），顺带看看任课关系有没有回填 subject_code。
--   0 行 = 姓名打错 → ② 里的判据会全 false，别误读成"权限没收窄对"。
select id, name, subject, primary_subject_code, created_at from teachers order by created_at, id;

--  ② 写判据函数在真实数据上的表现（把 uuid 换成要核对的老师 id）
--
--  【本副本的改动 · 2026-09-27 改回真函数】schema.sql 原文写的是：
--    with me as (select '<要核对的老师 id>'::uuid as uid)
--    select t.name, cs.subject, cs.subject_code, c.name as 班级,
--           can_edit_exam_for((select uid from me), array[c.id], cs.subject_code, cs.subject) as 他能改
--    from class_subjects cs
--    join classes c on c.id = cs.class_id
--    join teachers t on t.id = cs.teacher_id
--    order by 1, 4;
--  **这条现在可以原样跑了**：`can_edit_exam_for` 已建（schema.sql §15.2，定义在
--  薄包装之前），所以下面 ②–A 直接调真函数，不再用等价改写。
--  ⚠️ 注意第一个业务参数是**数组**（考试可以多班）：`array[c.id]` —— 别照 §16.6 的
--     标量写法抄成 `c.id`。
--
--  【当初为什么要改写 · 留档，别再改回去】那时 `can_edit_exam_for` **故意没有建**
--     （schema.sql §15.4 的旧注释：认为它不需要在编辑器里被指定人核对），照抄会报
--     `function public.can_edit_exam_for(uuid, uuid[], text, text) does not exist`。
--     当时改写成**已经存在的两个 _for 变体**：
--       能改 = is_school_admin_for(核对对象)                        -- super / admin 兜底那一支
--              or teaches_subject_for(核对对象, 这个班, 这行的学科)   -- "在这班教这一科"那一支
--     那两支合起来正是 can_edit_exam() 的函数体，语义等价 —— 但那是**判据的第二处手抄**：
--     函数体一改，这里就悄悄与数据库分叉（这正是补 `_for` 变体的理由，schema.sql §18.1）。
--     ⚠️ is_school_admin_for 对 authenticated 是 revoke 的，但 SQL 编辑器以 postgres 身份跑，
--     所以当时那样写不报错 —— 报错的是**函数不存在**，不是权限。
--
--  🔴 【实测踩到的分叉 · 读串了列】用户跑上一版时看到 `测试账号 / 测试专用 / false`，
--     而同一个人同一个班同一个科，走 §16.6 ② 的问法 `teaches_subject_for(t.id, …)` 是 true
--     —— 看着像矛盾，其实是**两种问法**（已用 PGlite 在同一批数据上复现）：
--       · 前四列（`t.name` / `cs.subject` / `cs.subject_code` / 班级）说的是**这一行是谁的**；
--       · 最后一列答的是 **`me`（核对对象，默认「示例教师」）能不能改这一行** —— 两件事。
--     （下面把"那位物理老师"简写成「示例教师」、「那个测试账号」简写成「测试账号」
--       —— 真名只存在于库里，公开仓库里不写。）
--     于是 `me` = 示例教师时那一行 false 的意思是"**示例教师**改不了测试账号的那一行"（正确：
--     示例教师不在「测试专用」班任教），**不是**"测试账号改不了自己的班"。
--     同一批数据两种问法的实测对照（rls-checks 第十三节也钉着）：
--       §15.4② 的问法（me = 示例教师）        → 测试账号/测试专用 = **false**，示例教师自己两行 = true
--       同一句把 me 换成测试账号             → 测试账号/测试专用 = true，示例教师两行 = false
--       §16.6② 的问法（判每一行自己的老师）  → 三行**全 true**
--     所以下面加了 ②–B：要问"他自己能不能"，第一参数就得是 `t.id`。
--  ⚠️ 另一个会把这条读成"全 false"的坑：`me` 按姓名查不到人 → CTE 是空集 →
--     依赖它的判据**全部**为 false（假失败）。先跑上面那条「人是谁」确认查得到人。
--
--  ②–A 照 schema.sql 原文：**指定一个人**（`me`），看他能不能改**每一行**
--     期望：`就是核对对象本人 = true` 的那几行 `核对对象能改这一行` 也是 true；
--           别人的行 = false（这正是"写不了别人的班"）。
with me as (select id as uid from teachers where name = '示例教师' order by created_at, id limit 1)
select t.name as 这一行是谁的, cs.subject, cs.subject_code, c.name as 班级,
       can_edit_exam_for((select uid from me), array[c.id], cs.subject_code, cs.subject) as 核对对象能改这一行,
       (t.id = (select uid from me)) as 就是核对对象本人
from class_subjects cs
join classes c on c.id = cs.class_id
join teachers t on t.id = cs.teacher_id
order by 1, 4;

--  ②–B 换一种问法：判**每一行自己的老师**（这个问法不会读串列 —— 问的就是他本人）
--     期望：**每一行都是 true**（任课关系在，判定就一定成立）。
select t.name as 老师, cs.subject as 学科, c.name as 班级,
       can_edit_exam_for(t.id, array[c.id], cs.subject_code, cs.subject) as 他自己能改
from class_subjects cs
join classes c on c.id = cs.class_id
join teachers t on t.id = cs.teacher_id
order by 1, 3;

--  ②–C 汇总：②–B 里判不出 true 的行数 —— **应为 0**
--     （非 0 说明有一条任课关系判不过自己的判据：学科列回填错了、或班挂错了）
select count(*) as 应为0
from class_subjects cs
join classes c on c.id = cs.class_id
where not can_edit_exam_for(cs.teacher_id, array[c.id], cs.subject_code, cs.subject);

-- ★ 本副本新增（内容来自 schema.sql §15.5，第 1577-1596 行）：
--  年级排名怎么算 —— **没有额外的表，靠这一条查询**。
--  用户口径：「年级考试 → 按学科把整个年级同一场考试的数据读出来，排年级排名和班级排名」。
--  同一场考试的判据是 **paper_key + subject_code + grade + exam_date**，这四样都在 exams 上，
--  所以年级排名不需要"先建一次年级考试再把各班挂上去"这种结构 ——
--  每个班的任课老师各建各的档案，读的时候按上面四样合起来就是一次年级考试。
--  班级排名：班内按总分排名；年级排名：把那四样相同的所有班的分合起来排名。
--  ⚠️ 要改：'物理练习8' 换成真实的 paper_key
--     （先看一眼有哪些：select paper_key, subject, grade, exam_date from exams order by exam_date desc;）
with same_paper as (
  select e.id, e.title, e.paper_key, e.exam_date, e.class_ids
  from exams e
  where e.scope = 'grade' and e.paper_key = '物理练习8'
)
select s.class_id, s.student_no, s.name, s.total,
       rank() over (partition by s.class_id order by s.total desc nulls last) as 班级排名,
       rank() over (order by s.total desc nulls last)                      as 年级排名
from exam_scores s
join same_paper p on p.id = s.exam_id
where not s.absent
order by 年级排名;


-- ============================================================
--  第 4 段 · §16.6 核对：删旧策略前后，逐人逐动作
--  来源：supabase/schema.sql 第 2108-2157 行
--
--  🔴 这一段怎么用（顺序很重要）：
--    第 16 段是**全仓库唯一不可逆**的一段 —— 它删掉 §7 那批 `for all` 旧策略（§16.4）。
--    所以：**跑 §16.4 删旧策略之前，先跑一次这一段并把结果记下来**
--    （① 那六个计数），删完再跑一次，**两边逐行对比**。
--    本文件只含它的核对查询，**不会**替你删任何策略。
--  在验什么 / 期望看到什么：
--    ① 逐人可见量：班级 / 学生 / 作业 / 自己建的 / 呼叫 / 教室端 六个计数 ——
--       **删前删后必须逐行完全相同**。删旧策略不该让任何人少看见一行
--       （本段只重写了读策略里"自己建的"那几支，效果与旧 `for all` 的 select 分支相等）。
--    ② 逐人逐动作：管理身份那几行 `能管这个班 = true`；任课老师 `能管这个班 = false`
--       但 `能改本班物理 = true`；班主任 / 年级主任 `能改本班物理 = **false**`（用户口径："只读"）。
--    ③ 矩阵审计：每张表的策略都能在 §16.1 那张表里找到出处；
--       **教室里那块屏不出现在任何写策略里**。
--    ④ 教室端账号**不该有**任何一张业务表的写权限。
--  要改什么：① 的姓名（默认「示例教师」——占位符，跑前换成真名）；④ 默认取 classroom_accounts 里最早的那个账号。
-- ============================================================

--  ① 逐人可见量对照（**这是"删之前 / 删之后"要相等的那组数**）
--     🔴 怎么用：**跑本段之前先跑一次并记下来**，跑完再跑一次，两边逐行对比。
--     期望：**逐行相同** —— 本段只重写了读策略里"自己建的"那几支（16.3.0），
--     效果与旧 `for all` 策略的 select 分支**相等**；删旧策略不该让任何人少看见一行。
--     把 uuid 换成要核对的老师 id（`select id, name, subject from teachers;` 拿）。
--
--  【本副本的改动】原版是写死 uuid：
--    with me as (select '<要核对的老师 id>'::uuid as uid)
--  这里改成按姓名查（默认核对「示例教师」——占位符，跑前换成真名）。换人：改姓名；有重名就把 `limit 1`
--  换成明确的 `where id = '……'::uuid`。
with me as (select id as uid from teachers where name = '示例教师' order by created_at, id limit 1)
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
select tablename, policyname, cmd, roles
  from pg_policies where schemaname = 'public' order by tablename, cmd, policyname;

-- ★ 本副本新增：【先跑这一条】教室里那几个账号到底是哪些。
--   ④ 要用它们的 id；默认取最早建的那个（可以改成看指定的一行）。
select id, name, email, class_id, disabled, created_at
  from classroom_accounts order by created_at, id;

--  ④ 🔴 教室端的安全边界：它**不该有**任何一张业务表的写权限。
--     把教室端账号的 uuid 填进去，下面每一条都应该是 0 行 / 抛"策略拒绝"。
--     （本副本已经不用手填了 —— 见下面的【本副本的改动】。）
--     最省事的做法是照 16.6 ③ 的清单人工看一眼，或者跑 `npm run rls-checks`
--     （`app/scripts/rls-checks.mjs` 第七节：给教室端逐个动作打 11 条写操作，全拒才算过；
--       顺带用 `pg_policies` 静态审一遍「assignments 上没有任何一条策略提到 classroom_accounts」）。
--
--  【本副本的改动】原版是写死一个**假 uuid**：
--    with room as (select '77777777-7777-7777-7777-777777777777'::uuid as uid)
--  这个 uuid 在库里根本不存在 → 三个计数必然全是 0 → 看起来"通过了"，
--  其实**什么都没验**（典型的假通过）。这里改成查真实账号：
--    with room as (select id as uid from classroom_accounts order by created_at, id limit 1)
--  期望（**注意和原版注释的差别**）：教室端账号行数 = **1**（说明确实取到了那个账号，
--  这个 1 是"查对了人"的证据，不是问题）；任课关系行数 = 0、身份行数 = 0 ——
--  这两个 0 意味着他在 can_manage_class / can_grade_subject / teaches_in_class
--  三个判据上**永远为假** → 16.3 的写策略一条都匹配不上 → 只读。
--  想核指定账号：把 '★ 先跑这一条' 里拿到的 id 填成
--    with room as (select '……'::uuid as uid)   -- 原版的写法，把 …… 换成真 id
with room as (select id as uid from classroom_accounts order by created_at, id limit 1)
select
  (select count(*) from classroom_accounts where id = (select uid from room)) as 教室端账号行数,
  (select count(*) from class_subjects where teacher_id = (select uid from room)) as 任课关系行数,
  (select count(*) from teacher_roles  where teacher_id = (select uid from room)) as 身份行数;
--  —— 两个 0 意味着他在 can_manage_class / can_grade_subject / teaches_in_class
--     三个判据上**永远为假** → 16.3 的写策略一条都匹配不上 → 只读。


-- ============================================================
--  没放进本文件的（免得你以为漏了；它们在 schema.sql 里各有位置）
--   · §14「确认每张表都开了 RLS」——schema.sql 第 1341-1342 行，`--` 注释状态：
--       select tablename from pg_tables
--        where schemaname = 'public' and rowsecurity = false;
--     跑完应返回 0 行。（不属于本次要摘的四段，所以只在这里记一笔。）
--   · §10.5 ③ 的核对（第 13.5 的注释说"和第 10.5 ③ 是同一个套路"）。
--   · §16.7 的回退 SQL —— 那是**写操作**（create policy），不属于只读自检。
--   · §18 的 `_for` 变体登记与核对 SQL（2026-09-27 新增那一节）——
--     §18.3 有三条只读核对（其中「`_for` 变体必须都 revoke」那条已由
--     `npm run rls-checks` 第十三节机器化，不必手跑）。
--   · §12.6 的「主学科显式指派」模板 —— 也是写操作（update teachers），
--     只在 §12.5 ① 报出非 0 时才需要照着改。
--   · 另有一份更完整的自动化核对：`app/scripts/rls-checks.mjs`（`npm run rls-checks`），
--     它用 PGlite 跑真 Postgres + 真策略，比这里的 SQL 覆盖得多
--     （考试写判据在**第十三节**，含多班数组语义、教室端、以及"裸版在编辑器里恒 false"
--      这条让 §15.4 ② 非补 `_for` 不可的原因）。
-- ============================================================
