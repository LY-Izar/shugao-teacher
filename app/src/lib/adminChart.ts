/* ============================================================
   超管运维面板的**纯逻辑**（第一期）
   ------------------------------------------------------------
   这个文件里**没有 React、没有 store、没有任何写入**。
   三件事，各自都是纯函数或只读探测：

     · `scanAssignmentContradictions()` —— E7：`assignments` 内部矛盾扫描。
       **纯前端、零额外请求**（面板方案 §二 E7）。五类检查逐条对应
       `功能设计与不变量.md` §十 里那五条"看起来很正常"的错数据。
     · `probeSchemaDrift()` —— C1：`schema.sql` §10–§19 各段漂移总表。
       用的**全是现成那套判据**（表存在性看 `42P01` / `PGRST205` /
       `schema cache`，列存在性看 `42703`），没有新发明一套。
     · 几个把状态翻成人话/颜色的**判据函数**（G2 / B1 / A3 的红黄绿）。

   ⚠️ 三条硬纪律（都来自面板方案）：
    ① **隐私三级**（§五）：A 聚合计数默认显示；B 可定位到人但不含内容的
       **默认只给计数，点开才看，且学号在前姓名最后**；C 教学内容与成绩
       **一律不显示**（连均分/最高分都不显示）。所以这里返回的结构里
       **根本没有成绩字段** —— 不是"界面上不渲染"，而是**拿不到**。
       人名只在"账号"语境下出现（老师姓名），学生姓名一律不出现在本文件。
    ② **不绕开 RLS**（§一 / I16）：这里全部请求都走调用者自己的 anon 会话，
       判据仍然是数据库的策略与函数。需要 `service_role` 的项（§17 的策略清单、
       §18 的 `_for` 变体登记）**如实标成"无法判断"**，绝不猜。
    ③ **"无法判断"是独立的第四种状态**（§3.4 第 4 条），不能归到绿。
   ============================================================ */

import { getSupabase } from './supabase'

/* ============================================================
   E7 · `assignments` 内部矛盾扫描（🟢 纯前端、零额外请求）
   ============================================================ */

/** 五类矛盾各自的稳定编号 —— 界面、断言、文档都用它 */
export type ContradictionKind = 'missing-graded' | 'missing-correction' | 'corrected-orphan' | 'collected-fake' | 'simple-pollution'

/**
 * 一条明细。
 *
 * 🔴 **这里刻意没有学生姓名，也没有成绩**（隐私三级里的 C 类）：
 *    `studentNos` 是**学号**——按项目全局约定"学号即身份"（§一），
 *    而面板判"是不是同一个人"只需要键，不需要名字。
 *    要看姓名得回档案页面看（那里本来就有权限判据）。
 */
export type ContradictionDetail = {
  /** 这件事发生在哪份档案上（给"跳转到那份档案"用） */
  assignmentId: string
  title: string
  /** 班名；班已被删/读不到时是空串 */
  className: string
  /** 涉及的学生**学号**（升序，最多 20 个；多余的用 `extra` 报数量） */
  studentNos: string[]
  /** 超过 20 个时剩下的数量 */
  extra: number
  /** 这一条具体是什么（例：「未交名单里有 2 人已批改」） */
  detail: string
  /** 为什么会这样 / 修法提示（照 §十 的留档口径写） */
  why: string
}

export type ContradictionGroup = {
  kind: ContradictionKind
  label: string
  /** 这一类在**全部**档案里一共命中几份（不是明细条数） */
  assignments: number
  /** 这一类一共涉及几个"人·次" */
  hits: number
  details: ContradictionDetail[]
}

export type ContradictionReport = {
  /** 扫了几份档案（口径：RLS 筛过之后的可见档案 —— 对超管等于全校） */
  scanned: number
  /** 有矛盾的档案数（**按份去重**，一份档案可能同时命中两类） */
  badCount: number
  /** 有矛盾的档案 id（界面用它报"红卡"的颜色） */
  badIds: string[]
  groups: ContradictionGroup[]
  /** 汇总成一句话给 L1 卡用 */
  summary: string
}

/** 扫描只需要的字段形状（结构化传入，**不依赖 store 的具体类型**） */
export type ScanAssignment = {
  id: string
  title: string
  classId: string
  status: string
  collected: boolean
  statsMode?: string
  missingNos?: string[]
  lateNos?: string[]
  confirmedNos?: string[]
  subQuestions?: Record<string, number>
  wrong?: Record<string, unknown>
  grades?: Record<string, unknown>
  correctionNos?: string[]
  correctedNos?: string[]
}

const LIST_CAP = 20

/** 学号升序（数字优先，与 `store` 里排名单的口径一致） */
function sortedNos(set: Set<string>): string[] {
  return [...set].sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return a.localeCompare(b)
  })
}

function detailOf(
  a: ScanAssignment,
  className: string,
  nos: Set<string>,
  detail: string,
  why: string,
): ContradictionDetail {
  const all = sortedNos(nos)
  return {
    assignmentId: a.id,
    title: a.title,
    className,
    studentNos: all.slice(0, LIST_CAP),
    extra: Math.max(0, all.length - LIST_CAP),
    detail,
    why,
  }
}

/**
 * **E7 的全部判据**（五类，逐条对应 §十 的五条留档）。
 *
 * 正常长什么样：`badCount === 0`，屏上「作业档案 5 份，内部一致」。
 * 异常长什么样：屏上「**作业档案 1 份自相矛盾**」+ 每类一条人话。
 *
 * ⚠️ 判据只读 `assignments` 自己的字段，**不查任何别的表** ——
 *    这就是"零额外请求"的实现方式。
 */
export function scanAssignmentContradictions(
  assignments: readonly ScanAssignment[],
  classNames: ReadonlyMap<string, string> = new Map(),
): ContradictionReport {
  const groups = new Map<
    ContradictionKind,
    { kind: ContradictionKind; label: string; details: ContradictionDetail[] }
  >([
    ['missing-graded', { kind: 'missing-graded', label: '未交 ∩ 已批改', details: [] }],
    ['missing-correction', { kind: 'missing-correction', label: '未交 ∩ 改错名单', details: [] }],
    [
      'corrected-orphan',
      { kind: 'corrected-orphan', label: '已改错 ⊄ 改错名单（孤儿）', details: [] },
    ],
    ['collected-fake', { kind: 'collected-fake', label: 'collected 假真', details: [] }],
    [
      'simple-pollution',
      { kind: 'simple-pollution', label: '极简模式混进逐题数据', details: [] },
    ],
  ])
  const badIds = new Set<string>()

  for (const a of assignments) {
    const cn = classNames.get(a.classId) ?? ''
    /** 记一条明细（空集合 = 这一类没命中，什么都不做） */
    const hit = (kind: ContradictionKind, nos: Set<string>, detail: string, why: string) => {
      if (!nos.size) return
      groups.get(kind)!.details.push(detailOf(a, cn, nos, detail, why))
      badIds.add(a.id)
    }
    const missing = new Set((a.missingNos ?? []).map(String))
    const correction = new Set((a.correctionNos ?? []).map(String))

    /*
     * ① 未交 ∩ 已批改
     *    根因（§十）：「照片查缺登记的未交里混着已批改的人」——
     *    降级确认只挂在一处（三态循环的绿→红分支），照片预填的 missing
     *    与 OCR 自带的结果都不经过那里，保存时直接落库。
     *    判据 = 未交名单 ∩ (批改产物：wrong 的键 ∪ grades 的键)。
     *  ⚠️ `confirmedNos` **不能**当这个判据：极简模式里它表示"评过等级的人"，
     *     批改路径上它表示"展开过题号的人" —— 一个字段两种语义，
     *     拿它当"已批改"会在极简档案上误报（这正是本项目反复吃的教训）。
     */
    const graded = new Set<string>([
      ...Object.keys(a.wrong ?? {}),
      ...Object.keys(a.grades ?? {}),
    ])
    const missingGraded = new Set([...missing].filter((n) => graded.has(n)))
    hit(
      'missing-graded',
      missingGraded,
      `未交名单里有 ${missingGraded.size} 人已有批改产物`,
      '一个人不可能既未交又已批改。根因是"降级确认只挂在一处"，漏了照片预填 / OCR 两条写入路径（§十）。' +
        '修法要人工判断哪一边说了算，**面板不给自动修复**（自动修必然猜错）。',
    )

    /* ② 未交 ∩ 改错名单
     *    根因（§十）：「改成未交的人还挂在改错名单里」—— `doDemote` 只删了
     *    `wrong` / `confirmedNos`，`correctionNos` / `correctedNos` / `grades` 没清。 */
    const missingCorrection = new Set([...missing].filter((n) => correction.has(n)))
    hit(
      'missing-correction',
      missingCorrection,
      `改错名单里有 ${missingCorrection.size} 人是未交`,
      '没交作业的人不可能"改错"。根因是清数据时只删了 `wrong`/`confirmedNos`，' +
        '`correctionNos` 没跟着收缩（§十）。',
    )

    /* ③ `correctedNos` 孤儿：已改错必须 ⊆ 改错名单
     *    根因（§十）：「改错登记按钮显示 `2/1`」—— 名单收缩时只写 `correctionNos`，
     *    `correctedNos` 留着孤儿记录，那个人还会从"已改错"表里消失（撤销入口跟着没了）。 */
    const orphan = new Set(
      (a.correctedNos ?? []).map(String).filter((n) => !correction.has(n)),
    )
    hit(
      'corrected-orphan',
      orphan,
      `已改错名单里有 ${orphan.size} 人不在改错名单里`,
      '孤儿记录。屏上的表现是改错登记按钮显示「2/1」这种"已改的比该改的还多"的数（§十）。',
    )

    /* ④ `collected` 假真
     *    `collected` 的语义**只有一个**：**收缴登记这一步真的做过**。
     *    只有「收缴登记」与「确认完成批改」两条真正点过全班的路能置它。
     *    根因（§十）：「还没登记收缴的档案在列表里写着全员交齐」——
     *    `setGrade` 曾经用 `|| Boolean(data.confirmedNos?.length)` 抬 `collected`，
     *    临时保存批了几个人，列表就宣称"已交 36/36 · 全员交齐"。
     *    判据：`collected === true`，却（状态还是 open）**且**（未交名单为空）。
     *      · 真收缴登记过 → `collected: true` + `status: 'collected'`（不是 open）
     *      · 真收缴登记过 → `missingNos` 是"只记例外"的那份登记结果
     *    两条路都不该留下"open + 没人未交 + 却标着已登记"的组合。 */
    if (a.collected === true && a.status === 'open' && (a.missingNos ?? []).length === 0) {
      badIds.add(a.id)
      groups.get('collected-fake')!.details.push(
        detailOf(
          a,
          cn,
          new Set(),
          '标着"已登记收缴"，但状态还是"待收缴"、未交名单也是空的',
          '`collected` 的语义只有"收缴登记做过"。这个组合说明它是被别的写入路径抬起来的' +
            '（§十：`setGrade` 曾用 `|| Boolean(confirmedNos.length)` 抬它）。' +
            '老师会以为收缴登记做过了 —— 而列表当时显示的是"全员交齐"。',
        ),
      )
    }

    /* ⑤ 极简模式的伪题数 / 逐题数据污染
     *    `statsMode = 'simple'` 是**另一套数据模型**：只有等级，没有逐题。
     *    根因（§十 两条）：「极简模式在改错登记里人人全对」「完成页报共 6 题」——
     *    统一是"读逐题数据的每一处都要先按 `statsMode` 分流"。
     *    判据：simple 档案上 `wrong` 非空，或 `subQuestions` 非空。 */
    const wrongKeys = Object.keys(a.wrong ?? {})
    const subKeys = Object.keys(a.subQuestions ?? {})
    if (a.statsMode === 'simple' && (wrongKeys.length || subKeys.length)) {
      badIds.add(a.id)
      groups.get('simple-pollution')!.details.push(
        detailOf(
          a,
          cn,
          new Set(wrongKeys),
          `极简档案上却有逐题数据（\`wrong\` ${wrongKeys.length} 人${subKeys.length ? ` · \`subQuestions\` ${subKeys.length} 题` : ''}）`,
          '极简模式没有"题"这个概念。这是两套数据模型串了 —— 屏上会渲染成' +
            '「共 N 题 / 错题 0 / 错误率 0%」这种**看起来很正常**的错结论（§十）。',
        ),
      )
    }
  }

  const groupsOut: ContradictionGroup[] = [...groups.values()].map((g) => {
    const ids = new Set(g.details.map((d) => d.assignmentId))
    return {
      kind: g.kind,
      label: g.label,
      assignments: ids.size,
      hits: g.details.reduce((n, d) => n + d.studentNos.length + d.extra, 0),
      details: g.details,
    }
  })

  const badCount = badIds.size
  const scanned = assignments.length
  return {
    scanned,
    badCount,
    badIds: [...badIds],
    groups: groupsOut,
    summary: badCount
      ? `作业档案 ${scanned} 份，**${badCount} 份自相矛盾**`
      : `作业档案 ${scanned} 份，内部一致`,
  }
}

/** 有矛盾的组（界面上只列这几组，干净的组不占版面） */
export function dirtyGroups(r: ContradictionReport): ContradictionGroup[] {
  return r.groups.filter((g) => g.details.length > 0)
}

/* ============================================================
   C1 · `schema.sql` **逐段**漂移总表（🆕 2026-10-08：段清单改为自动生成）
   ------------------------------------------------------------
   🔴 **为什么改**（用户 2026-10-08 原话）：
      「数据表，我们都更新到多少了，怎么这里只能探到这些」——
      线上库早跑到 §37 了，而这张表只列 §10–§19 ✗。
      根因：那份"逐段跑没跑"的清单是**手写死的一段**（旧 `sectionDefs()`），
      `schema.sql` 后来加的 §20–§37 它根本不知道存在 —— 和"§18.1 脚本计数表过期"
      是同一个毛病：**清单跟不上 schema**。

   ✅ **现在的口径**：段号 / 标题 / 行号锚点 / "这一段建了什么" / **探针**全部由
      `app/scripts/admin-checks.mjs --gen-stages` 从 `supabase/schema.sql` 解析后生成，
      生成的数组就是下面那个 `SCHEMA_STAGES`（带 `@gen:schema-stages` 标记）。
      门禁每次都会**重解析一遍 `schema.sql` 并与它逐字节比对** —— 有人改了 schema.sql
      却忘了重新生成，`admin-checks` 当场红 ✅（反向对照见第七节）。
      ⚠️ **不许手动改 `SCHEMA_STAGES`**（改了门禁就红，等于白改）。

   面板方案 §二 C1 的"探测手法"原文：**每条都用现成那套判据，别新写一套** ——
     · 表存在性：`select('*').limit(1)` → 看错误码（`42P01` / `PGRST205` / `schema cache`）
     · 列存在性：`select('<列>').limit(1)` → 看 `42703` / `does not exist`
     · 🆕 策略存在性（2026-10-11）：**问 `pg_policies`** → 逐条判在/不在；
       库不暴露它（PostgREST 只暴露 `public`）→ 这一段**如实留在"面板探不到"**。
       ⚠️ 这一条**推翻了**方案那句"策略 anon key 查不到 → 标无法判断"里的一半：
          "查不到"是对的，但**查不到不等于不能问** —— 问了、答案是"库不暴露"，
          那就是一条**准确的**结论（"本面板问不到策略"），比一句笼统的"无法判断"有用。

   🔴 **一处刻意的偏离**（2026-09-28 收尾轮，留档在 `功能设计与不变量.md` §20.7）：
      表存在性探针**不用 `select('id')`，改用 `select('*')`**。
      方案那行"照抄 `remote.ts` 的手法"里藏着一个假设 ——**每张表都有 `id` 列** ——
      而 `subjects` 没有（主键是 `code`，`schema.sql` §12.1）。
      后果是一次**会误导人的误报**：线上库明明跑完了 §12，面板却报
      「§12 未跑 → 列不存在 → 写路径摘掉那一列」，证据是
      `42703 column subjects.id does not exist` —— 那是"列不在"，被泛判据
      `/does not exist/i` 当成了"表不在"。
      → 表存在性只问"这张表在不在"，**不许假设任何一列存在**。
   ============================================================ */

export type DriftState = 'present' | 'missing' | 'indeterminate'

export type DriftCell = {
  /** 这一格在探什么（例：`classroom_accounts` 表） */
  what: string
  state: DriftState
  /** 原始证据：那一句错误，或者"读到了"（**面板上要能看见，不能只给颜色**） */
  evidence: string
}

/**
 * 这一段的**种类** —— 🔴 这两者**必须分开**（用户 2026-10-08：「这正是现在看不懂的原因」）：
 *   · `'sql'`      —— 有可执行 SQL：能探、会红、会灰；
 *   · `'registry'` —— **登记节**（0 行可执行 SQL，例如 §14 与 §18）：
 *        **没有东西可跑、也没有东西可探**，所以它既不该红、也不该算"探不到"。
 *        旧面板把 §18 混在 §19 那种"已跑"里列出来，读的人自然看不懂。
 */
export type DriftKind = 'sql' | 'registry'

export type DriftSection = {
  /** 段号，如 `§15` */
  stage: string
  /** 这一段在 `schema.sql` 里的原标题（自动生成） */
  title: string
  /** 这一段建了什么（自动生成：表 / 列 / 无参函数） */
  built: string
  /** 不跑会怎样 —— **静默症状**（危险段是人工留档，其余是通用句） */
  impact: string
  /** 怎么修 */
  fix: string
  state: DriftState
  cells: DriftCell[]
  /** 整份 `schema.sql` 里对应的小节（给"复制段号"用） */
  anchor: string
  /** 有可执行 SQL / 登记节 */
  kind: DriftKind
  /**
   * **面板探不到**的原因（只有 `kind === 'sql'` 且没有探针时才有）。
   * ⚠️ 它与"探测没结论"（`state === 'indeterminate'` 但有 cells）是**两件事**：
   *    这一档是"这个问题不该问面板"，所以它**不参与**卡片的红黄绿。
   */
  noProbe?: string
}

/* ============================================================
   🆕 2026-10-11 · 「策略在不在」的探针 —— 问 `pg_policies`
   ------------------------------------------------------------
   病灶（用户 2026-10-11 点名）：清单改成一节一节从 `schema.sql` 自动生成之后，
   **探针仍然只认"表 / 加列 / 无参函数"** —— 于是"**只加 policy**"的段
   （§35 / §36 / §37）`targets` 是空的 → 永远躺在"面板探不到"那一档，
   而总结论「线上库已跑到 §NN」**偏低**（库到 §37，面板说 §34）。

   🔴 **唯一的信息来源就是数据库**：一条策略有没有生效，只写在
      `pg_catalog.pg_policies` 里 —— 表在不在看 `42P01`、函数在不在看 `PGRST202`，
      策略**没有第三个客户端可观测的形状**（"读这张表回 0 行"既可能是"策略挡住了"、
      也可能是"表里本来就没行"，拿它当判据就是假绿）。
      → 所以这里**只问 `pg_policies`**，不问别的。

   🔴 **三种答法必须分开**（这一段的全部意义就在这三分）：
      · 读到行 → 逐条判"在 / 不在"（进红黄绿，`present` / `missing`）；
      · 库**不暴露**它（PostgREST 默认只暴露 `public`，`pg_catalog` 不在它的
        schema cache 里 → `PGRST205`）→ `'no-oracle'`：**本面板探不到**
        （如实留在那一档：不是"没跑"，也不是绿）；
      · 网络 / 认不出的错 → `'error'`：**没结论**（灰，绝不是红）。
      ⚠️ 红线：`'no-oracle'` **绝不许**被当成 `missing`（那是把"问不到"说成"没跑"），
         也**绝不许**被当成 `present`（那是拿"表在"冒充"策略在"）。

   ⚠️ `select('*')` —— **不假设 `pg_policies` 有任何一列**（§20.7 的纪律）。
      列名只在**读到行之后**才拿来取值；读到行却认不出那两列 → 也算"没结论"，并报出来。
   ⚠️ **一次探测只发一次请求**（记忆化）：全表拉一次，比"每条策略问一次"省得多。
      `probeSchemaDrift()` 每次调用会把它清空，所以"重新探测"拿到的是新数据。
   ============================================================ */

type PoliciesOracle =
  | { kind: 'rows'; rows: ReadonlyArray<Record<string, unknown>> }
  | { kind: 'no-oracle'; evidence: string }
  | { kind: 'error'; evidence: string }

let policiesPromise: Promise<PoliciesOracle> | null = null

/** 问一次 `pg_policies`（只读；整个面板共用这一个 promise） */
function readPolicies(): Promise<PoliciesOracle> {
  if (policiesPromise) return policiesPromise
  policiesPromise = (async (): Promise<PoliciesOracle> => {
    const sb = getSupabase()
    if (!sb) return { kind: 'error', evidence: '本地模式：没有云端连接' }
    try {
      const { data, error } = await sb.from('pg_policies' as never).select('*')
      if (error) {
        const code = String((error as { code?: string }).code ?? '')
        const msg = String(error.message ?? '')
        if (MISSING_TABLE_RE.test(code) || MISSING_TABLE_RE.test(msg)) {
          return {
            kind: 'no-oracle',
            evidence:
              `${code || '?'} ${msg}`.trim() +
              '（PostgREST 只暴露 `public`，`pg_catalog.pg_policies` 不在它的 schema cache 里 → ' +
              '**本面板问不到策略**；这不是"策略没跑"）',
          }
        }
        return { kind: 'error', evidence: `${code || '?'} ${msg}`.trim() }
      }
      const rows = Array.isArray(data) ? (data as ReadonlyArray<Record<string, unknown>>) : []
      return { kind: 'rows', rows }
    } catch (e) {
      return { kind: 'error', evidence: String(e) }
    }
  })()
  return policiesPromise
}

/**
 * 一条策略在不在。
 *
 * 返回值 `null` = **本面板探不到**（库不暴露 `pg_policies`）——
 * ⚠️ 它与"探测没结论"（返回一个 `indeterminate` 的格）是**两件事**：
 * 前者不进"格"，于是这一段落回"面板探不到"那一档（不参与卡的红黄绿）；
 * 后者进"格"，于是这一段是**灰**（有结论尝试过、只是没拿到）。
 */
async function probePolicy(table: string, name: string): Promise<DriftCell | null> {
  const what = `策略 \`${name}\`（\`${table}\` 上）`
  const o = await readPolicies()
  if (o.kind === 'no-oracle') return null
  if (o.kind === 'error') return { what, state: 'indeterminate', evidence: o.evidence }
  const rows = o.rows
  /* 一行都没读到：要么整库真的一条策略都没有，要么形状对不上 —— **不下"不在"的结论** */
  if (!rows.length) {
    return {
      what,
      state: 'indeterminate',
      evidence: '`pg_policies` 读到了 0 行 —— 不据此说"这条策略不在"（宁可说不知道）',
    }
  }
  const named = rows.filter((r) => typeof r?.policyname === 'string')
  if (!named.length) {
    return {
      what,
      state: 'indeterminate',
      evidence: '读到了 `pg_policies`，但行里认不出 `policyname` / `tablename` 两列（形状不认识）',
    }
  }
  const hit = named.some((r) => r.policyname === name && r.tablename === table)
  return hit
    ? { what, state: 'present', evidence: '在 `pg_policies` 里（这一条策略确实建出来了）' }
    : { what, state: 'missing', evidence: `\`pg_policies\` 里没有 \`${table}\` 上的 \`${name}\`` }
}

const OK = '读到了（无错误）'

/**
 * 「**表**不存在」的判据 —— 只认这三样：
 *   · `42P01`（Postgres `undefined_table`，文案是 `relation "public.x" does not exist`）；
 *   · `PGRST205`（PostgREST 在自己的 schema cache 里找不到这张表）；
 *   · 两句兜底文案（老版本 PostgREST 不带码，只给话）。
 *
 * 🔴 **这里绝不能只写一个泛化的 `/does not exist/i`** —— 那正是 §20.7 那次误报：
 *    「列不存在」的文案（`column subjects.id does not exist`，码 `42703`）里也有
 *    "does not exist"，于是**表在、只是没有探针点的那一列**会被判成"表不在"，
 *    整段报红"未跑"。判据必须问的是"**relation / 表** 在不在"，
 *    而 `column … does not exist` 属于下面那条 `MISSING_COL_RE`。
 */
const MISSING_TABLE_RE = /42P01|PGRST205|Could not find the table|relation .+ does not exist/i
/** 「**列**不存在」：`42703`（`undefined_column`）/ `column <表>.<列> does not exist` */
const MISSING_COL_RE = /42703|column .+ does not exist/i

/**
 * 表在不在。
 *
 * ⚠️ **判据比 `remote.isMissingTable()` 更严，是有意的**（`adminChart` 这里独立一份，
 *    因为那个没导出）：`remote` 那一份是给**写路径**用的，判错的代价是"把写入永久停掉"，
 *    所以它宁可把认不出的错都当成"表在"；而面板判错的代价是**一次假红警报**
 *    （§20.7 那次就是它），所以它只认"表/relation 不存在"本身，
 *    `42703 column … does not exist` 一律不进"表不在"。
 */
async function probeTable(table: string): Promise<DriftCell> {
  const sb = getSupabase()
  const what = `\`${table}\` 表`
  if (!sb) return { what, state: 'indeterminate', evidence: '本地模式：没有云端连接' }
  try {
    /*
     * 🔴 `select('*')`，**不是 `select('id')`** —— 表存在性只跟"这张表在不在"有关。
     *    `select('id')` 偷偷假设了"每张表都有 `id` 列"，而 `subjects` 没有
     *    （主键是 `code`，`schema.sql` §12.1）→ `42703 column subjects.id does not exist`
     *    → 一次"§12 明明跑过了却报未跑"的误报（§20.7）。
     */
    const { error } = await sb.from(table).select('*').limit(1)
    if (!error) return { what, state: 'present', evidence: OK }
    const code = String((error as { code?: string }).code ?? '')
    const msg = String(error.message ?? '')
    if (MISSING_TABLE_RE.test(code) || MISSING_TABLE_RE.test(msg)) {
      return { what, state: 'missing', evidence: `${code || '?'} ${msg}`.trim() }
    }
    /*
     * 「列不存在」**不是**"表不在"的证据 → 只能记"无法判断"（灰），**绝不许红**。
     * `select('*')` 之后这一支只可能出现在"有人把探针改回拿某一列探表"的时候，
     * 留着它是为了让那个写法的症状是**灰**而不是**假红**。
     */
    if (MISSING_COL_RE.test(code) || MISSING_COL_RE.test(msg)) {
      return {
        what,
        state: 'indeterminate',
        evidence: `${code || '?'} ${msg}（这一列不在，但**不能**据此说这张表不在）`.trim(),
      }
    }
    return { what, state: 'indeterminate', evidence: `${code || '?'} ${msg}`.trim() }
  } catch (e) {
    return { what, state: 'indeterminate', evidence: String(e) }
  }
}

/** 列在不在 —— 与 `remote.ensureSubjectCols` 同一套判据 */
async function probeColumn(table: string, column: string): Promise<DriftCell> {
  const sb = getSupabase()
  const what = `\`${table}.${column}\` 列`
  if (!sb) return { what, state: 'indeterminate', evidence: '本地模式：没有云端连接' }
  try {
    const { error } = await sb.from(table).select(column).limit(1)
    if (!error) return { what, state: 'present', evidence: OK }
    const code = String((error as { code?: string }).code ?? '')
    const msg = String(error.message ?? '')
    if (MISSING_COL_RE.test(code) || MISSING_COL_RE.test(msg)) {
      return { what, state: 'missing', evidence: `${code || '?'} ${msg}`.trim() }
    }
    /*
     * 表不在 ⇒ 这一列当然也不在（同一件事，仍然是"这一段没跑"）。
     * 少了这一支的话，`PGRST205`（表不在 schema cache 里）会被记成"无法判断" ——
     * 那是把**确实没跑**说成"不知道"，同样是一种失真。
     */
    if (MISSING_TABLE_RE.test(code) || MISSING_TABLE_RE.test(msg)) {
      return {
        what,
        state: 'missing',
        evidence: `${code || '?'} ${msg}（表不在，这一列当然也不在）`.trim(),
      }
    }
    return { what, state: 'indeterminate', evidence: `${code || '?'} ${msg}`.trim() }
  } catch (e) {
    return { what, state: 'indeterminate', evidence: String(e) }
  }
}

/**
 * RPC 函数在不在。
 *
 * ⚠️ **只调"裸版"（无参），绝不调带参数的判据函数、也绝不调 `_for` 变体**：
 *    · §18 的 `_for` 变体是 `revoke ... from public, anon, authenticated` 的
 *      （它们的用途是"在 SQL 编辑器里显式指定人核对"），拿 anon 会话去调会得到
 *      `permission denied` —— 那既不能证明它在、也不能证明它不在。
 *    · 🔴 **带参数的函数一律不探**：探它得**伪造实参**，而 `schema.sql` 里带参数的函数
 *      有 `grade_delete(...)` / `migrate_nos_to_serial()` / `promote_grades(...)` /
 *      `purge_old_subject_data(...)` 这些**会写库**的 —— 面板是只读的，
 *      **绝不做有副作用的探测**（这条纪律比"多探一段"重要得多）。
 *    无参裸版则在 §13 那句 `grant execute` 之后是可调的，且**对未登录调用恒为 false**，
 *    所以"调到并返回 false"本身就是"函数存在且判据正确"的证据。
 *
 * 🆕 **`42501 permission denied` 算"在"**（2026-10-08 补，随清单扩展到全段而来）：
 *    PostgREST 先在自己的 schema cache 里找这个函数 —— 找不到才是 `PGRST202`
 *    （真的不在）；找到了、但当前角色没有 execute 权限才会回 `42501`。
 *    所以 `42501` 反过来**证明函数在**。少了这一支，`is_school_admin()` /
 *    `visible_class_ids()` 这些"给策略用、没 grant 给 anon"的函数会被记成灰，
 *    整张卡就永远绿不了（那是把"确实在"说成"不知道"，同样是失真）。
 */
async function probeRpc(fn: string, args: Record<string, unknown> = {}): Promise<DriftCell> {
  const sb = getSupabase()
  const what = `函数 \`${fn}()\``
  if (!sb) return { what, state: 'indeterminate', evidence: '本地模式：没有云端连接' }
  try {
    const { data, error } = await sb.rpc(fn as never, args as never)
    if (!error) return { what, state: 'present', evidence: `返回 ${JSON.stringify(data)}` }
    const code = String((error as { code?: string }).code ?? '')
    const msg = String(error.message ?? '')
    // PostgREST 找不到这个函数（或签名对不上）时的错误码
    if (code === 'PGRST202' || /could not find the function|does not exist|schema cache/i.test(msg)) {
      return { what, state: 'missing', evidence: `${code || '?'} ${msg}`.trim() }
    }
    /*
     * 🆕 `42501 permission denied for function x` ⇒ **函数在**（见上面那段注释）：
     *    能被 PostgREST 找到、只是这个角色没 execute 权限 —— 那是"在"的证据，不是"不在"。
     */
    if (code === '42501' || /permission denied for function/i.test(msg)) {
      return {
        what,
        state: 'present',
        evidence: `${code || '?'} ${msg}（**函数在**：能被 PostgREST 找到，只是当前角色没有 execute 权限）`.trim(),
      }
    }
    return { what, state: 'indeterminate', evidence: `${code || '?'} ${msg}`.trim() }
  } catch (e) {
    return { what, state: 'indeterminate', evidence: String(e) }
  }
}

/* ============================================================
   段清单 · 🔴 **自动生成**（`app/scripts/admin-checks.mjs --gen-stages`）
   ------------------------------------------------------------
   下面这个数组是从 `supabase/schema.sql` 解析出来的**全部段**：
     · `n` / `title` / `from` / `to` —— 段号、标题、**行号区间**（行号也跟着走，
        所以不会再出现"锚点行号过期"）；
     · `sql` —— 这一段**去掉 `--` 注释与空行之后还剩几行**（`0` = **登记节**）；
     · `targets` —— 这一段建出来的、**anon 会话探得到**的东西（表 / 列 / 无参函数）。
   ⚠️ **不许手动改这一段**：手改了就与 `schema.sql` 对不上，`admin-checks` 第七节当场红。
       要更新清单：改完 `schema.sql` 之后跑 `node scripts/admin-checks.mjs --gen-stages`
   ============================================================ */

export type StageTarget =
  | { kind: 'table'; name: string }
  | { kind: 'col'; table: string; column: string }
  | { kind: 'fn'; name: string }
  /**
   * 🆕 **策略**（`create policy <name> on <table>`）—— 第三类产物，2026-10-11 补。
   *
   * 🔴 为什么它必须单独一类：`create policy` **建不出表、也建不出函数**，
   *    所以在旧清单里，§35 / §36 / §37 这种"只加策略"的段的 `targets` 是**空的** →
   *    它们躺在"面板探不到"那一档，而总结论（`latest`）**偏低**
   *    （库到 §37，面板说 §34）。
   */
  | { kind: 'policy'; table: string; name: string }

export type SchemaStage = {
  n: number
  title: string
  /** `schema.sql` 里的 1-based 起止行（含首尾） */
  from: number
  to: number
  /** 可执行 SQL 的行数（去掉 `--` 注释与空行）—— `0` = **登记节** */
  sql: number
  targets: StageTarget[]
}

/* @gen:schema-stages BEGIN */
export const SCHEMA_STAGES: readonly SchemaStage[] = [
  { n: 1, title: '教师', from: 15, to: 135, sql: 54, targets: [{ kind: 'table', name: 'teachers' }, { kind: 'table', name: 'teacher_profiles' }, { kind: 'col', table: 'teachers', column: 'notice_seen_at' }] },
  { n: 2, title: '班级与学生', from: 137, to: 190, sql: 27, targets: [{ kind: 'table', name: 'classes' }, { kind: 'table', name: 'students' }, { kind: 'table', name: 'student_profiles' }] },
  { n: 3, title: '作业档案', from: 192, to: 240, sql: 35, targets: [{ kind: 'table', name: 'assignments' }, { kind: 'col', table: 'assignments', column: 'question_meta' }, { kind: 'col', table: 'assignments', column: 'stats_mode' }, { kind: 'col', table: 'assignments', column: 'grades' }, { kind: 'col', table: 'assignments', column: 'focus_nos' }, { kind: 'col', table: 'assignments', column: 'correction_nos' }, { kind: 'col', table: 'assignments', column: 'corrected_nos' }] },
  { n: 4, title: '教师课表（每周重复）', from: 242, to: 263, sql: 16, targets: [{ kind: 'table', name: 'schedule_items' }, { kind: 'col', table: 'schedule_items', column: 'scope' }] },
  { n: 5, title: '教室端与呼叫', from: 265, to: 292, sql: 22, targets: [{ kind: 'table', name: 'classrooms' }, { kind: 'table', name: 'calls' }] },
  { n: 6, title: '显式授权', from: 294, to: 317, sql: 7, targets: [] },
  { n: 7, title: '行级安全（RLS）—— 每张表都要开，漏一张就等于全校数据裸奔', from: 319, to: 396, sql: 51, targets: [{ kind: 'policy', table: 'teachers', name: 'teachers_self_select' }, { kind: 'policy', table: 'teachers', name: 'teachers_self_insert' }, { kind: 'policy', table: 'teachers', name: 'teachers_self_update' }, { kind: 'policy', table: 'classes', name: 'classes_own' }, { kind: 'policy', table: 'students', name: 'students_own' }, { kind: 'policy', table: 'assignments', name: 'assignments_own' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_own' }, { kind: 'policy', table: 'classrooms', name: 'classrooms_own' }, { kind: 'policy', table: 'calls', name: 'calls_own' }] },
  { n: 8, title: '实时推送', from: 398, to: 415, sql: 12, targets: [] },
  { n: 9, title: '教师端 → 教室端 的文件互传', from: 417, to: 479, sql: 34, targets: [{ kind: 'table', name: 'shared_files' }, { kind: 'policy', table: 'shared_files', name: 'shared_files_own' }, { kind: 'policy', table: 'objects', name: 'classroom_files_read' }, { kind: 'policy', table: 'objects', name: 'classroom_files_insert' }, { kind: 'policy', table: 'objects', name: 'classroom_files_delete' }] },
  { n: 10, title: '权限与账号体系 · 阶段 1（建表 / 回填 / RLS 函数）', from: 481, to: 1145, sql: 289, targets: [{ kind: 'table', name: 'schools' }, { kind: 'table', name: 'grades' }, { kind: 'table', name: 'teacher_roles' }, { kind: 'table', name: 'class_subjects' }, { kind: 'table', name: 'classroom_accounts' }, { kind: 'col', table: 'classes', column: 'school_id' }, { kind: 'col', table: 'classes', column: 'grade_id' }, { kind: 'col', table: 'teacher_roles', column: 'subject_code' }, { kind: 'fn', name: 'visible_class_ids' }, { kind: 'fn', name: 'is_classroom_account' }, { kind: 'policy', table: 'schools', name: 'schools_read' }, { kind: 'policy', table: 'grades', name: 'grades_read' }, { kind: 'policy', table: 'teacher_roles', name: 'teacher_roles_read' }, { kind: 'policy', table: 'class_subjects', name: 'class_subjects_read' }, { kind: 'policy', table: 'classroom_accounts', name: 'classroom_accounts_read' }] },
  { n: 11, title: '阶段 2：新策略与旧策略**并存**（只加，不删）', from: 1147, to: 1216, sql: 30, targets: [{ kind: 'policy', table: 'classes', name: 'classes_visible' }, { kind: 'policy', table: 'students', name: 'students_visible' }, { kind: 'policy', table: 'assignments', name: 'assignments_visible' }, { kind: 'policy', table: 'calls', name: 'calls_visible' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_class_visible' }, { kind: 'policy', table: 'classrooms', name: 'classrooms_visible' }, { kind: 'policy', table: 'classrooms', name: 'classrooms_heartbeat' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_classroom_write' }] },
  { n: 12, title: '多学科 · 阶段 1（学科字典 / subject_code 加列 / 回填）', from: 1218, to: 1380, sql: 68, targets: [{ kind: 'table', name: 'subjects' }, { kind: 'col', table: 'assignments', column: 'subject_code' }, { kind: 'col', table: 'teachers', column: 'primary_subject_code' }, { kind: 'policy', table: 'subjects', name: 'subjects_read' }] },
  { n: 13, title: '多学科 · 阶段 3：建号带学科 + 身份判据 + 学科可见性分级', from: 1382, to: 2019, sql: 363, targets: [{ kind: 'fn', name: 'is_super_admin' }, { kind: 'fn', name: 'can_manage_teachers' }, { kind: 'fn', name: 'can_create_teacher_accounts' }, { kind: 'fn', name: 'can_assign_roles' }, { kind: 'fn', name: 'can_assign_super_role' }, { kind: 'fn', name: 'subject_lead_class_ids' }, { kind: 'fn', name: 'subject_lead_subject_codes' }, { kind: 'policy', table: 'assignments', name: 'assignments_visible' }] },
  { n: 14, title: '自检：确认每张表都开了 RLS', from: 2021, to: 2026, sql: 0, targets: [] },
  { n: 15, title: '考试（2026-09-27 新增）', from: 2028, to: 2367, sql: 142, targets: [{ kind: 'table', name: 'exams' }, { kind: 'table', name: 'exam_scores' }, { kind: 'policy', table: 'exams', name: 'exams_visible' }, { kind: 'policy', table: 'exams', name: 'exams_write' }, { kind: 'policy', table: 'exam_scores', name: 'exam_scores_visible' }, { kind: 'policy', table: 'exam_scores', name: 'exam_scores_write' }] },
  { n: 16, title: '收口 · 阶段 5：逐表写策略矩阵 + can_grade 落地 + 删旧策略', from: 2369, to: 3023, sql: 289, targets: [{ kind: 'table', name: 'schedule_snoozes' }, { kind: 'fn', name: 'is_school_admin' }, { kind: 'policy', table: 'classes', name: 'classes_visible' }, { kind: 'policy', table: 'students', name: 'students_visible' }, { kind: 'policy', table: 'calls', name: 'calls_visible' }, { kind: 'policy', table: 'classrooms', name: 'classrooms_visible' }, { kind: 'policy', table: 'classes', name: 'classes_insert' }, { kind: 'policy', table: 'classes', name: 'classes_update' }, { kind: 'policy', table: 'classes', name: 'classes_delete' }, { kind: 'policy', table: 'students', name: 'students_insert' }, { kind: 'policy', table: 'students', name: 'students_update' }, { kind: 'policy', table: 'students', name: 'students_delete' }, { kind: 'policy', table: 'assignments', name: 'assignments_insert' }, { kind: 'policy', table: 'assignments', name: 'assignments_update' }, { kind: 'policy', table: 'assignments', name: 'assignments_delete' }, { kind: 'policy', table: 'calls', name: 'calls_insert' }, { kind: 'policy', table: 'calls', name: 'calls_update' }, { kind: 'policy', table: 'calls', name: 'calls_delete' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_mine_read' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_mine_write' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_class_write' }, { kind: 'policy', table: 'schedule_snoozes', name: 'schedule_snoozes_own' }, { kind: 'policy', table: 'classrooms', name: 'classrooms_insert' }, { kind: 'policy', table: 'classrooms', name: 'classrooms_update' }, { kind: 'policy', table: 'classrooms', name: 'classrooms_delete' }] },
  { n: 17, title: '收口 · 教室端的**三条**裂缝（2026-09-25 拍板「收紧」A/B；2026-09-27 收紧 C）', from: 3025, to: 3221, sql: 37, targets: [{ kind: 'policy', table: 'teachers', name: 'teachers_not_classroom' }, { kind: 'policy', table: 'teachers', name: 'teachers_not_classroom_insert' }, { kind: 'policy', table: 'teachers', name: 'teachers_not_classroom_update' }, { kind: 'policy', table: 'teachers', name: 'teachers_not_classroom_delete' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_classroom_scope_only' }, { kind: 'policy', table: 'shared_files', name: 'shared_files_not_classroom_insert' }, { kind: 'policy', table: 'shared_files', name: 'shared_files_not_classroom_update' }, { kind: 'policy', table: 'shared_files', name: 'shared_files_not_classroom_delete' }] },
  { n: 18, title: '判据函数的 `_for` 变体（2026-09-27 补）：为什么每个判据都要两件套', from: 3223, to: 3325, sql: 0, targets: [] },
  { n: 19, title: '共享文件的**班级归属**（2026-09-28）：教师端 → 教室端 的文件互传，**读**这一侧修通', from: 3327, to: 3588, sql: 64, targets: [{ kind: 'col', table: 'shared_files', column: 'class_ids' }, { kind: 'policy', table: 'shared_files', name: 'shared_files_class_read' }, { kind: 'policy', table: 'shared_files', name: 'shared_files_class_scope_insert' }, { kind: 'policy', table: 'shared_files', name: 'shared_files_class_scope_update' }, { kind: 'policy', table: 'objects', name: 'classroom_files_read' }] },
  { n: 20, title: '序列号键迁移（P1，2026-09-25）', from: 3590, to: 4258, sql: 475, targets: [{ kind: 'table', name: 'student_serial_counters' }, { kind: 'col', table: 'students', column: 'serial' }, { kind: 'col', table: 'students', column: 'legacy_student_no' }, { kind: 'fn', name: 'assign_student_serials' }, { kind: 'fn', name: 'migrate_nos_to_serial' }, { kind: 'fn', name: 'serial_migration_report' }, { kind: 'fn', name: 'revert_nos_to_legacy' }] },
  { n: 21, title: '通知（2026-09-28 新增）—— 「学校对老师说话」', from: 4260, to: 5299, sql: 550, targets: [{ kind: 'table', name: 'notices' }, { kind: 'table', name: 'notice_targets' }, { kind: 'table', name: 'teacher_departments' }, { kind: 'col', table: 'notice_targets', column: 'target_department' }, { kind: 'fn', name: 'notice_sendable_roles' }, { kind: 'fn', name: 'notice_departments' }, { kind: 'fn', name: 'my_notice_scopes' }, { kind: 'policy', table: 'teacher_departments', name: 'teacher_departments_read' }, { kind: 'policy', table: 'notices', name: 'notices_visible' }, { kind: 'policy', table: 'notice_targets', name: 'notice_targets_visible' }] },
  { n: 22, title: '全站公告（2026-09-28 公告轮）—— 「**平台**对老师说话」', from: 5301, to: 5484, sql: 56, targets: [{ kind: 'table', name: 'announcements' }, { kind: 'fn', name: 'can_publish_announcement' }, { kind: 'policy', table: 'announcements', name: 'announcements_visible' }] },
  { n: 23, title: '平台设置：**维护模式**（2026-09-29 管理台第二期）—— 「平台对自己说话」', from: 5486, to: 5619, sql: 34, targets: [{ kind: 'table', name: 'admin_audit' }, { kind: 'table', name: 'site_state' }, { kind: 'col', table: 'site_state', column: 'version' }, { kind: 'col', table: 'site_state', column: 'force' }, { kind: 'col', table: 'site_state', column: 'url_apk' }, { kind: 'col', table: 'site_state', column: 'url_exe' }] },
  { n: 24, title: '前端错误日志（2026-09-29 管理台第二期 · `frontend_errors`）', from: 5621, to: 5802, sql: 81, targets: [{ kind: 'table', name: 'frontend_errors' }] },
  { n: 25, title: '用户反馈（2026-09-29 管理台第二期 · `feedback`）', from: 5804, to: 5933, sql: 45, targets: [{ kind: 'table', name: 'feedback' }, { kind: 'fn', name: 'can_contact_admin' }] },
  { n: 26, title: '运维只读报告：**数据库用量**（2026-09-29 管理台第二期）', from: 5935, to: 6055, sql: 44, targets: [{ kind: 'fn', name: 'db_usage_report' }] },
  { n: 27, title: '开学准备（P6，2026-09-30）', from: 6057, to: 6907, sql: 564, targets: [{ kind: 'table', name: 'student_subjects' }, { kind: 'table', name: 'class_members' }, { kind: 'col', table: 'grades', column: 'cohort' }, { kind: 'col', table: 'grades', column: 'stage' }, { kind: 'col', table: 'grades', column: 'enrolled_at' }, { kind: 'col', table: 'classes', column: 'kind' }, { kind: 'col', table: 'classes', column: 'class_type' }, { kind: 'col', table: 'classes', column: 'stream_key' }, { kind: 'policy', table: 'student_subjects', name: 'student_subjects_read' }, { kind: 'policy', table: 'student_subjects', name: 'student_subjects_write' }, { kind: 'policy', table: 'class_members', name: 'class_members_read' }] },
  { n: 28, title: '学年 / 学期 / 届（P3）+ 存量回填（P2），2026-09-30', from: 6909, to: 7349, sql: 288, targets: [{ kind: 'table', name: 'academic_years' }, { kind: 'table', name: 'terms' }, { kind: 'col', table: 'assignments', column: 'term_id' }, { kind: 'col', table: 'exams', column: 'grade_id' }, { kind: 'fn', name: 'beijing_today' }, { kind: 'fn', name: 'current_term_id' }, { kind: 'fn', name: 'can_manage_terms' }, { kind: 'fn', name: 'p3_backfill_terms_and_cohorts' }, { kind: 'policy', table: 'academic_years', name: 'academic_years_read' }, { kind: 'policy', table: 'terms', name: 'terms_read' }] },
  { n: 29, title: '提档 + 毕业删除（P4，2026-10-01）', from: 7351, to: 8265, sql: 700, targets: [{ kind: 'table', name: 'grade_promotions' }, { kind: 'table', name: 'grade_removals' }, { kind: 'fn', name: 'current_academic_year' }, { kind: 'fn', name: 'can_promote_grades' }, { kind: 'fn', name: 'promotion_overview' }] },
  { n: 31, title: '统一模型改造（P5，2026-10-03）🔴 **风险最高的一期**', from: 8267, to: 8437, sql: 50, targets: [{ kind: 'policy', table: 'assignments', name: 'assignments_insert' }, { kind: 'policy', table: 'assignments', name: 'assignments_update' }] },
  { n: 32, title: '走班班（P7，2026-10-04）—— 生成 + 分配老师 + `can_stream` 废弃', from: 8439, to: 8879, sql: 296, targets: [] },
  { n: 33, title: '教室端的两块新能力（P9，2026-10-05）', from: 8881, to: 9089, sql: 74, targets: [{ kind: 'policy', table: 'calls', name: 'calls_insert' }, { kind: 'policy', table: 'calls', name: 'calls_update' }, { kind: 'policy', table: 'calls', name: 'calls_delete' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_classroom_admin_only_insert' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_classroom_admin_only_update' }, { kind: 'policy', table: 'schedule_items', name: 'schedule_classroom_admin_only_delete' }, { kind: 'policy', table: 'calls', name: 'calls_classroom_admin_only' }] },
  { n: 34, title: '收尾（P10，2026-10-05）', from: 9091, to: 9606, sql: 334, targets: [{ kind: 'table', name: 'student_subject_changes' }, { kind: 'policy', table: 'student_subject_changes', name: 'student_subject_changes_read' }] },
  { n: 35, title: '学生档案的可见性与修改权（2026-10-06）', from: 9608, to: 9689, sql: 30, targets: [{ kind: 'policy', table: 'student_profiles', name: 'student_profiles_visible' }, { kind: 'policy', table: 'student_profiles', name: 'student_profiles_insert' }, { kind: 'policy', table: 'student_profiles', name: 'student_profiles_update' }, { kind: 'policy', table: 'student_profiles', name: 'student_profiles_delete' }] },
  { n: 36, title: '🆕 教师档案的可见性与修改权（2026-10-06）', from: 9691, to: 9765, sql: 15, targets: [{ kind: 'policy', table: 'teacher_profiles', name: 'teacher_profiles_visible' }, { kind: 'policy', table: 'teacher_profiles', name: 'teacher_profiles_insert' }, { kind: 'policy', table: 'teacher_profiles', name: 'teacher_profiles_update' }] },
  { n: 37, title: '🔑 走班班的编辑 / 删除（走班班也是 `classes` 的一行）', from: 9767, to: 9881, sql: 53, targets: [] },
  { n: 38, title: '🆕 课程管理（第 1 轮：**数据层**）—— 调课的两条路 + 冲突判据 + 过期清理', from: 9883, to: 10829, sql: 596, targets: [{ kind: 'table', name: 'schedule_temp_changes' }, { kind: 'table', name: 'schedule_temp_archive' }, { kind: 'table', name: 'schedule_perm_changes' }, { kind: 'fn', name: 'purge_expired_schedule_changes' }, { kind: 'policy', table: 'schedule_temp_changes', name: 'schedule_temp_changes_read' }, { kind: 'policy', table: 'schedule_temp_changes', name: 'schedule_temp_changes_insert' }, { kind: 'policy', table: 'schedule_temp_changes', name: 'schedule_temp_changes_update' }, { kind: 'policy', table: 'schedule_temp_archive', name: 'schedule_temp_archive_read' }, { kind: 'policy', table: 'schedule_perm_changes', name: 'schedule_perm_changes_read' }] },
  { n: 39, title: '函数执行权限收口（2026-10-01 安全加固 A8）', from: 10831, to: 10900, sql: 25, targets: [] },
  { n: 40, title: '教室端改造（**数据层**）—— 每日作业 / 值日生 / 校历 / 课代表口令', from: 10902, to: 11382, sql: 297, targets: [{ kind: 'table', name: 'daily_homework' }, { kind: 'table', name: 'duty_assignments' }, { kind: 'table', name: 'school_calendar' }, { kind: 'table', name: 'class_rep_pins' }, { kind: 'table', name: 'class_rep_pin_fails' }, { kind: 'policy', table: 'daily_homework', name: 'daily_homework_read' }, { kind: 'policy', table: 'duty_assignments', name: 'duty_assignments_read' }, { kind: 'policy', table: 'daily_homework', name: 'daily_homework_insert' }, { kind: 'policy', table: 'daily_homework', name: 'daily_homework_update' }, { kind: 'policy', table: 'daily_homework', name: 'daily_homework_delete' }, { kind: 'policy', table: 'duty_assignments', name: 'duty_assignments_write' }, { kind: 'policy', table: 'school_calendar', name: 'school_calendar_read' }, { kind: 'policy', table: 'school_calendar', name: 'school_calendar_write' }] },
  { n: 41, title: '推送令牌（2026-10-02）—— apk 前台服务的"到点也能收到通知"链路', from: 11384, to: 11424, sql: 13, targets: [{ kind: 'table', name: 'push_tokens' }] },
  { n: 42, title: '🔴 维护模式 = **服务端真的禁写**（2026-10-14 安全审计之后用户拍板）', from: 11426, to: 11584, sql: 76, targets: [{ kind: 'fn', name: 'is_maintenance' }] },
  { n: 43, title: '🔴 安全收紧第三批（本轮）：超管撤不成 0 个 · 教师自己删不掉自己那行 · 错误上报限洪', from: 11586, to: 11782, sql: 83, targets: [{ kind: 'col', table: 'frontend_errors', column: 'source_digest' }] },
  { n: 44, title: '🔴 超管隐身（本轮）：**非超管读者在任何入口都读不到超管的任何信息**', from: 11784, to: 11918, sql: 19, targets: [{ kind: 'policy', table: 'teacher_roles', name: 'teacher_roles_hide_super' }, { kind: 'policy', table: 'teacher_profiles', name: 'teacher_profiles_visible' }] },
]
/* @gen:schema-stages END */

/** 面板对每一段**最多探几格**（首屏请求数 ≈ 有探针的段数 × 这个数，只跑一次） */
export const PROBES_PER_STAGE = 2

/**
 * 危险段的「不跑会怎样 / 怎么修」—— **人工留档**，只补必须人说的那几段。
 *
 * ⚠️ 为什么这里可以手写、段清单却不行：**它不是"清单"**，是留档知识 ——
 *    `schema.sql` 里根本没有"不跑会怎样"这种话，**推不出来**。
 *    推得出来的东西（段号 / 标题 / 行号 / 建了什么 / 探什么）**一律自动生成**。
 *    没写留档的段走 `defaultImpact()` 的通用句 —— 不编、不猜。
 */
const IMPACT_NOTES: Record<number, { impact: string; fix?: string }> = {
  10: {
    impact:
      '身份读不到 → `loadMyRoles()` 自带兜底返回 `[]` → 界面上**不多任何入口、不报错**；' +
      '`grade_id` 列不存在 → 年级主任管不着自己建的班',
  },
  11: { impact: '读策略缺失 → 某些人少看见行，**不报错**', fix: '去跑第 11 段（它只加策略，重跑幂等）' },
  12: {
    impact:
      '列不存在 → 写路径**摘掉那一列**；`subject_code` 全空 → 判据退化成按显示名反查，**认不出就不匹配**',
    fix: '去跑第 12 段；跑完回填一次（§12.6 有模板）',
  },
  13: {
    impact: '权限函数不存在 → Function 返回 **503「去跑第 13 段」**（§13.6：**不是 403**，故意区分）',
    fix: '去跑第 13 段（跑完等十几秒让 PostgREST 刷缓存）',
  },
  14: { impact: '跑不跑都不改变行为；它是"每张表都开了 RLS"的判据来源（本段 0 行可执行 SQL）' },
  15: { impact: '表不存在 → `ensureExamTables()` 返回 `missing` → **考试功能整个静默变空**' },
  16: {
    impact: '只删旧策略不补新策略 → 建作业/批改/加学生**被 RLS 拒**，界面只显示"保存失败"= 刷新即丢',
    fix: '去跑第 16 段（这一段是**全仓唯一不可逆**的，跑之前先存一份 §16.6 的基线）',
  },
  17: { impact: '不跑 → 教室端账号仍能写业务表（安全裂缝）' },
  18: { impact: '没有 `_for` 变体 = **这条判据不可能被验证**（I33）；本段 0 行可执行 SQL' },
  19: { impact: '不跑 → **教室端拉到的文件列表恒为空，且不报错**' },
  26: { impact: '不跑 → 管理台「数据库用量」那一格永远是灰的（`db_usage_report()` 不存在）' },
}

type SectionDef = {
  stage: string
  title: string
  built: string
  impact: string
  fix: string
  anchor: string
  kind: DriftKind
  /**
   * ⚠️ `run()` 回 `null` = **本面板探不到**（只有策略探针会这样，见 `probePolicy()`）——
   *    这一格**不进 `cells`**，于是这一段如实落回"面板探不到"那一档。
   */
  probes: Array<{ what: string; run: () => Promise<DriftCell | null> }>
  noProbe?: string
}

/**
 * 这一段建了什么 —— **从 `targets` 拼**，不编。
 *
 * ⚠️ 策略**只报条数与名字**（屏上要看得见这一段到底加了哪几条），
 *    最长列 3 条 —— 一段加十几条策略是常事，全列出来会把卡片撑爆。
 */
function builtText(s: SchemaStage): string {
  const tables: string[] = []
  const cols: string[] = []
  const fns: string[] = []
  const policies: string[] = []
  for (const t of s.targets) {
    if (t.kind === 'table') tables.push(`\`${t.name}\``)
    else if (t.kind === 'col') cols.push(`\`${t.table}.${t.column}\``)
    else if (t.kind === 'policy') policies.push(`\`${t.name}\``)
    else fns.push(`\`${t.name}()\``)
  }
  const parts: string[] = []
  if (tables.length) parts.push(`建表 ${tables.join(' / ')}`)
  if (cols.length) parts.push(`加列 ${cols.join(' / ')}`)
  if (fns.length) parts.push(`无参判据函数 ${fns.join(' / ')}`)
  if (policies.length) {
    const head = policies.slice(0, 3).join(' / ')
    parts.push(
      `加策略 ${policies.length} 条（${head}${policies.length > 3 ? ` 等 ${policies.length} 条` : ''}）`,
    )
  }
  const head = parts.length ? parts.join(' · ') : '这一段没有建表 / 加列 / 策略 / 新建无参函数'
  return `${head}（本段共 ${s.sql} 行可执行 SQL）`
}

/** 没有人工留档时的通用句 —— 只说实话，不编具体后果 */
function defaultImpact(s: SchemaStage): string {
  return `这一段没跑 → 它建的东西不在，依赖它的功能会**静默少东西**（多半不报错）：${builtText(s)}`
}

/** 这一段是不是「只加策略」 —— 有策略、且**没有别的产物** */
function policiesOnly(s: SchemaStage): boolean {
  return s.targets.length > 0 && s.targets.every((t) => t.kind === 'policy')
}

/** 一段里那几条策略的名字（屏上要看得见，不能只说"只加策略"） */
function policyListText(s: SchemaStage): string {
  return s.targets
    .filter((t) => t.kind === 'policy')
    .map((t) => `\`${t.name}\`（\`${t.table}\` 上）`)
    .join(' / ')
}

/**
 * 「只加策略」的段为什么探不到 —— **要点名 `pg_policies`**，不许只说一句"探不到"。
 *
 * 🔴 这句话与 `NO_PROBE_REASON['§17']` 是同一件事的两种说法（§17 是策略 + 函数）。
 */
function policyNoProbeText(s: SchemaStage): string {
  return (
    `这一段**只加策略**：${policyListText(s)}。` +
    '策略唯一写在 `pg_catalog.pg_policies` 里，而 **PostgREST 默认只暴露 `public`** —— ' +
    'anon / authenticated 会话读不到它，所以**本面板问不到策略**。' +
    '🔴 **这既不是"没跑"，也不是绿**：要确认请跑 `supabase/自检.sql` 的策略清单那一段。'
  )
}

/** 一个探针目标 → 一次只读探测（判据仍是那三套：表 `42P01` / 列 `42703` / 函数 `PGRST202`；策略 `pg_policies`） */
function targetProbe(t: StageTarget): { what: string; run: () => Promise<DriftCell | null> } {
  if (t.kind === 'table') return { what: `\`${t.name}\``, run: () => probeTable(t.name) }
  if (t.kind === 'col')
    return { what: `\`${t.table}.${t.column}\``, run: () => probeColumn(t.table, t.column) }
  if (t.kind === 'policy')
    return { what: `策略 \`${t.name}\``, run: () => probePolicy(t.table, t.name) }
  return { what: `\`${t.name}()\``, run: () => probeRpc(t.name) }
}

/**
 * "面板探不到"的通用原因（**带参数的函数**那几段，以及一切确实没有可探产物的段）。
 *
 * ⚠️ 2026-10-11 起，"只加策略"的段**不再走这一句** —— 它有专门的
 *    `policyNoProbeText()`（点名 `pg_policies` + 那几条策略的名字）。
 *    这一句留给"产物全是带参数的函数"那种段。
 */
const NO_PROBE_TEXT =
  '这一段只加**带参数的函数**（或没有可探产物）—— ' +
  '带参数的函数要**伪造实参**才问得到，其中 `grade_delete` / ' +
  '`migrate_nos_to_serial` 那几个**会写库**，面板是只读的，绝不做有副作用的探测。' +
  '**这既不是"没跑"，也不是绿。**'

function sectionDefs(): SectionDef[] {
  return SCHEMA_STAGES.map((s) => {
    const kind: DriftKind = s.sql === 0 ? 'registry' : 'sql'
    const probes = kind === 'registry' ? [] : s.targets.slice(0, PROBES_PER_STAGE).map(targetProbe)
    const note = IMPACT_NOTES[s.n]
    /*
     * 🔴 `noProbe` 的两支：
     *   · 这一段**一条探针都没有** → 通用理由；
     *   · 这一段**只有策略** → 专用理由（点名 `pg_policies`）。
     *     ⚠️ 「只有策略」的段**即使挂了策略探针也要先备好这句** —— 因为策略探针
     *     在"库不暴露 `pg_policies`"时会**退掉**（返回 `null` → 不进格），
     *     那一段就又变成"一格都没有"，屏上得有话可说（而且必须是**准确**的那句）。
     */
    const policyOnly = policiesOnly(s)
    const noProbeText = policyOnly ? policyNoProbeText(s) : NO_PROBE_TEXT
    return {
      stage: `§${s.n}`,
      title: s.title,
      built: builtText(s),
      impact: note?.impact ?? defaultImpact(s),
      fix: note?.fix ?? `去 Supabase → SQL Editor 跑 supabase/schema.sql 第 ${s.n} 段`,
      anchor: `schema.sql §${s.n}（:${s.from}–${s.to}）`,
      kind,
      probes,
      noProbe: kind === 'sql' && (probes.length === 0 || policyOnly) ? noProbeText : undefined,
    }
  })
}

/**
 * 把若干格的结论合成一段的结论。
 *
 * ⚠️ 合成规则是**保守的**，而且刻意把"无法判断"和"未跑"分开：
 *   · 只要有一格 `missing` → **未跑**（红）；
 *   · 否则只要有 `indeterminate` → **无法判断**（灰，**绝不是绿**）；
 *   · 全 `present` → 已跑（绿）；
 *   · **一格都没有**（这一段的产物 anon key 根本探不到）→ 无法判断（灰）+ 说清原因。
 */
export function combineCells(cells: readonly DriftCell[]): DriftState {
  if (!cells.length) return 'indeterminate'
  if (cells.some((c) => c.state === 'missing')) return 'missing'
  if (cells.some((c) => c.state === 'indeterminate')) return 'indeterminate'
  return 'present'
}

/** `§17` / `§18` 为什么探不到 —— 这句话要显示在屏上，不能只留一个灰点 */
export const NO_PROBE_REASON: Record<string, string> = {
  '§17':
    '这一段的产物是 **restrictive 策略**，不是表也不是函数。策略只写在 `pg_policies` 里，' +
    '而 **PostgREST 默认只暴露 `public`** → 本面板问不到（`adminChart` 的策略探针会**如实**' +
    '报成"探不到"，既不红也不绿）。硬要探只能靠"故意写一次看它报不报错"，' +
    '那是**有副作用的探测** —— 面板不做。要确认请跑 `supabase/自检.sql` 第 4 段（③ 矩阵审计）。',
  '§18':
    '这一段是**登记节**（0 行可执行 SQL），产出的是 13 个 `_for` 变体，' +
    '而它们**全部 `revoke` 掉了 anon / authenticated** —— 拿面板的会话去调只会得到 ' +
    '`permission denied`，既不能证明在、也不能证明不在。要确认请跑 `supabase/自检.sql` 第 3/4 段。',
}

/**
 * C1 总表。
 *
 * 🟢 **不需要服务端 Function** —— 面板方案 §二 C1 与 §四 4.1 把这条标成 🟡
 * （"需要 Function + service_role 查 `pg_policies` / `pg_tables` / `pg_proc`"），
 * 但方案自己给的"探测手法"那一栏写的正是 **anon 也能用的那三套**
 * （表看 `42P01`/`PGRST205`、列看 `42703`、函数看 `PGRST202`）。
 *
 * 🔴 **逐段探走的是"客户端逐个探"这条路**（2026-10-08 拍板，留档在
 *    `功能设计与不变量.md`），**没有**加 `schema_status()` 那样的 RPC。理由：
 *      · 加 RPC 要改 `supabase/schema.sql` → **用户得再跑一遍整份 schema**
 *        （唯一不可逆的 §16 也在里面），而这件事的收益只是"少几次请求"；
 *      · 客户端这几探是**只读存在性探测**（表 / 列 / 无参函数），一次十来毫秒；
 *      · 段一多，请求确实变多 → 用 `PROBES_PER_STAGE` 封顶（每段最多 2 格）。
 *    ⚠️ 代价说清楚：全跑一次约等于「有探针的段数 × 2」次只读请求，**只在打开这一页时跑一次**
 *       （重新探测要手动点）。
 */
export async function probeSchemaDrift(): Promise<{ at: number; sections: DriftSection[] }> {
  /*
   * 🔴 每次重探都把 `pg_policies` 那一次询问清空 —— 否则"重新探测"会拿上一次的旧答案
   *    （面板上那个「重新探测」按钮存在的唯一理由就是"上次的答案不算数了"）。
   */
  policiesPromise = null
  const defs = sectionDefs()
  const sections = await Promise.all(
    defs.map(async (d): Promise<DriftSection> => {
      const raw = await Promise.all(d.probes.map((p) => p.run()))
      /*
       * 🔴 `null` = **本面板探不到**（库不暴露 `pg_policies`，见 `probePolicy()`）——
       *    它不是一格"无法判断"：它**不进 `cells`**，于是这一段落回
       *    "面板探不到（不是没跑）"那一档，**不参与**卡片的红黄绿。
       *    把 `null` 当成灰格，整张卡会永远灰；当成"不在"，那是假红。
       */
      const cells = raw.filter((c): c is DriftCell => c !== null)
      return {
        stage: d.stage,
        title: d.title,
        built: d.built,
        impact: d.impact,
        fix: d.fix,
        anchor: d.anchor,
        kind: d.kind,
        noProbe: d.noProbe,
        /*
         * 🔴 **登记节**（`sql === 0`）：没有可执行 SQL ⇒ 没有"跑没跑"这回事。
         *    它的 `state` 是 `present`（"没什么可跑的"），但**渲染时不许画绿点** ——
         *    屏上它走单独那一档（见 `Admin.tsx` 的 `kind === 'registry'` 分支）。
         */
        state: d.kind === 'registry' ? 'present' : combineCells(cells),
        cells,
      }
    }),
  )
  return { at: Date.now(), sections }
}

/** C1 卡上那一句话 + 五档分类（**登记节 / 探不到 / 没结论 三者必须分得开**） */
export function driftSummary(sections: readonly DriftSection[]): {
  state: DriftState
  text: string
  /** 未跑的段（红） */
  missing: DriftSection[]
  /** 探测本身没结论的段（灰） */
  unknown: DriftSection[]
  /**
   * **本面板按设计就探不到的段** —— 只加策略 / 只加带参数的函数那几段。
   *
   * ⚠️ 它们**不参与**这张卡的红黄绿 —— 否则这张卡**永远不可能是绿的**。
   *    理由不是"通融"：它们的产物（`create policy` / 带参数的函数）
   *    **连"没跑"都没法从面板上看出**（anon 读不到 `pg_policies`；带参数的函数要伪造实参，
   *    而那些函数里有会写库的），所以它们既不是绿也不是灰 ——
   *    它们是"**这个问题不该问面板**"。方案 §3.4 第 4 条要的是"无法判断**不能归到绿**"，
   *    而这里连"判断"这个动作都不存在。
   */
  unprobeable: DriftSection[]
  /**
   * 🆕 **登记节**（`schema.sql` 里 0 行可执行 SQL 的段，例如 §14 / §18）。
   *
   * 🔴 它与 `unprobeable` 是**两件事**（这正是旧面板看不懂的原因）：
   *    · 登记节 = **没有东西可跑**（不需要探，也不是"探不到"）；
   *    · 探不到 = **有东西可跑，但面板探不到**（可能真没跑）。
   */
  registry: DriftSection[]
  /** 灰 / 探不到那些段，各自的原因（屏上要逐条写出来，不能只说"无法判断"） */
  reasons: string[]
  /**
   * 🔴 **总结论**：线上库**探得到的最高一段**（`null` = 一段都没探到）。
   *
   * 这是用户真正要的那个数（「线上库已跑到 §NN」）——所以它是一等公民，
   * 而不是让人自己去十来个点里挑最大的那个。
   */
  latest: number | null
  /** `schema.sql` 里**有几段可执行**（`sql > 0`）—— 「共 §NN 段可执行」 */
  executableCount: number
} {
  const registry = sections.filter((s) => s.kind === 'registry')
  const missing = sections.filter((s) => s.state === 'missing')
  const unprobeable = sections.filter((s) => s.kind === 'sql' && s.cells.length === 0)
  const unknown = sections.filter((s) => s.state === 'indeterminate' && s.cells.length > 0)
  const probed = sections.filter((s) => s.kind === 'sql' && s.cells.length > 0)
  const presentProbed = probed.filter((s) => s.state === 'present')
  const latest = presentProbed.length
    ? Math.max(...presentProbed.map((s) => Number(s.stage.replace('§', ''))))
    : null
  const executableCount = sections.filter((s) => s.kind === 'sql').length
  const reasons = [...unknown, ...unprobeable].map(
    (s) => `${s.stage}：${NO_PROBE_REASON[s.stage] ?? s.noProbe ?? '这一段的产物 anon 会话探不到。'}`,
  )
  const base = { missing, unknown, unprobeable, registry, reasons, latest, executableCount }

  if (missing.length) {
    const s = missing[0]
    return { state: 'missing', text: `${s.stage} 未跑 → ${s.impact.split('；')[0]}`, ...base }
  }
  if (unknown.length) {
    return {
      state: 'indeterminate',
      text: `${unknown.map((s) => s.stage).join(' / ')} 探测没结论（**不是绿**）`,
      ...base,
    }
  }
  if (!probed.length) {
    return { state: 'indeterminate', text: '一段都探不到（没有云端连接？）—— 不是绿', ...base }
  }
  /*
   * 🟢 绿：**总结论**先说出口 —— 「线上库已跑到 §NN · 共 NN 段可执行」。
   * ⚠️ `latest` 是"**探得到且已跑**"的最高一段；探不到的段一律不进这个数，
   *    也不许被算成"没跑"（那是本项目最贵的那条教训）。
   */
  const registryText = registry.length ? `（另有 ${registry.length} 段是登记节，0 行 SQL）` : ''
  return {
    state: 'present',
    text:
      `线上库已跑到 §${latest} · 共 ${executableCount} 段可执行${registryText}` +
      (unprobeable.length ? ` · ${unprobeable.length} 段面板探不到（不是没跑）` : ''),
    ...base,
  }
}

/* ============================================================
   C2 · 前端探测汇总 —— 🆕 补上**第四个探测**（`lib/files.ts` 的 `ensureFileClassCols`）
   ------------------------------------------------------------
   旧面板底部写着：「第四个探测（`lib/files.ts` 的 `ensureFileClassCols`）**没有对外的
   只读 getter**，所以不在上面这张汇总里」✗ —— 于是那一行**永远缺着**。
   现在 `lib/files.ts` 补了 `getFileClassColsStatus()` / `getFileClassColsProbeAt()`
   （**只读、不改任何缓存语义**，照 `remote.getExamTablesProbeStatus()` 的写法），
   这一格就能被探了 ✅。

   ⚠️ 为什么要在**这里**合并、而不是去改 `data/remote.ts` 的 `probeReport()`：
      那四个探测的缓存/判据都在 `remote.ts` 里，而这一轮的文件边界不含它 ——
      合并这一下是纯函数，放在纯逻辑文件里正好，也**不新增第二套判据**。
   ============================================================ */

/** 与 `data/remote.ts` 的 `ProbeReportItem` **同形**（故意不 import 那个大模块，免得多一条依赖边） */
export type ClientProbeItem = {
  key: string
  label: string
  target: string
  state: 'present' | 'missing' | 'indeterminate'
  at: number | null
  note?: string
}
export type ClientProbeReport = { collectedAt: number; items: ClientProbeItem[] }

/** `lib/files.ts` 那个探测的对外三态（`pending` = 本次会话还没探过） */
export type FileProbeStatus = 'pending' | 'present' | 'missing' | 'indeterminate'

/**
 * 把「文件归属列」这一格并进 C2 汇总（**追加在最后**，顺序稳定）。
 *
 * `pending`（这一页还没探过那个列）→ 记 `indeterminate` 并**说清为什么**：
 * 它是"还没问"，不是"不在"，更不是绿（三态纪律）。
 */
export function withFileProbe(
  report: ClientProbeReport,
  status: FileProbeStatus,
  at: number | null,
): ClientProbeReport {
  const item: ClientProbeItem = {
    key: 'fileClassCols',
    label: '文件归属列',
    target: 'shared_files.class_ids',
    state: status === 'pending' ? 'indeterminate' : status,
    at,
    note:
      status === 'pending'
        ? '本次会话**还没探过**它（打开「文件互传」那一页才会探）—— 这不是"列不在"。'
        : '§19 没跑时列不在：写路径**摘掉这一列**改走老列 `class_id`（单个班）。',
  }
  return { collectedAt: report.collectedAt, items: [...report.items, item] }
}

/* ============================================================
   把状态翻成人话 / 颜色（G2 · B1 · A3）—— 判据集中在这里
   ============================================================ */

export type Tone = 'ok' | 'warn' | 'bad' | 'unknown'

/**
 * C1 的三态 → 颜色。**全仓只有这一处实现**（卡片角标 + 每一段前面的点都调它）。
 *
 * 🔴 不变量（`功能设计与不变量.md` §20.4 I45，2026-09-28 那次误报钉下来的）：
 *    **"没结论"（`indeterminate`）只能是灰，绝不能是红**；
 *    **红（`bad`）只在"确实没跑"（`missing`）时出现**。
 *
 *    为什么要把这条做成一个**具名函数**而不是写在渲染里：
 *      §20.7 那次误报的现场是"卡片红着脸说 §12 未跑" —— 判据在探测那一侧写错了
 *      （`select('id')` 探表 + `does not exist` 泛匹配），看上去却像是**渲染**把灰画成了红。
 *      渲染与判据分开以后，"灰是不是被画成红"这件事就有了一个可以被断言钉住的点：
 *      `admin-checks.mjs` 第七节·补 直接断言 `driftTone('indeterminate') !== driftTone('missing')`。
 */
export function driftTone(state: DriftState): Tone {
  if (state === 'present') return 'ok'
  if (state === 'missing') return 'bad'
  return 'unknown'
}

/** 一块 L1 卡的颜色汇总：红 > 黄 > 灰 > 绿 */
export function worstTone(tones: readonly Tone[]): Tone {
  if (tones.includes('bad')) return 'bad'
  if (tones.includes('warn')) return 'warn'
  if (tones.includes('unknown')) return 'unknown'
  return 'ok'
}

/** 拿给人看的时间：`3 小时前` / `2 天前` / `刚刚` */
export function agoText(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '未知'
  const d = Math.max(0, now - at)
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`
  return `${Math.round(d / 86_400_000)} 天前`
}

/** 字节数 → 人话（与 `lib/files.ts` 的 `humanSize` 同款，这里独立一份免得跨界依赖） */
export function humanBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '未知'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/* ---------------- G2 备份的判据（阈值全部来自面板方案 §六 的验收口径） ---------------- */

/** 备份失败多久算红：**> 3 天**（方案 §六 第一期验收标准第 4 条原话） */
export const BACKUP_BAD_MS = 3 * 86_400_000
/** 备份"有点旧"的界限：36 小时（`backup.yml` 是每天 02:30 一次，超过一天半就该看一眼） */
export const BACKUP_WARN_MS = 36 * 3_600_000
/**
 * 最新备份的可疑下限：**50 KB**（方案 §六 验收标准第 4 条原话："最新备份 < 50 KB → 红"）。
 *
 * ⚠️ 为什么非要这个数：`backup.yml:9-11` 留档过一个真会丢备份的坑 ——
 *    旧写法 `pg_dump ... | gzip -9 > f.gz` 里 `$?` 拿到的是 **gzip 的退出码**，
 *    pg_dump 挂了会被吞掉，**留下一个「合法但空」的 .gz，工作流还显示绿灯**。
 *    → **只看"成功/失败"是抓不住这个坑的**，所以字节数必须显示、且必须有下限判据。
 */
export const BACKUP_MIN_BYTES = 50 * 1024

export type BackupJudgement = {
  tone: Tone
  /** 卡上那一句话 */
  text: string
  /** 补充说明（影响面 / 修法） */
  notes: string[]
}

export type BackupFacts = {
  /** 最近一次运行的结论（`success` / `failure` / …）；取不到是 null */
  conclusion: string | null
  /** 最近一次**成功**是多久以前的毫秒数 */
  lastSuccessAgoMs: number | null
  /** 最近一次运行是多久以前 */
  lastRunAgoMs: number | null
  /** 最新备份的字节数（从那次运行的日志里捞的）；捞不到是 null */
  sizeBytes: number | null
  /** 这次运行是不是走了 **Artifact 降级**（R2 没配） */
  degradedToArtifact: boolean
  /** R2 四个 secret 的配置情况（只有存在性，**没有值也没有长度**） */
  r2Keys: Record<string, boolean> | null
  /** 服务端 Function 有没有配置（false = 拿不到任何数据，不是"备份坏了"） */
  configured: boolean
}

/**
 * G2 的红黄绿。
 *
 * 🔴 这一条的**全部价值**在于一句话（面板方案 §二 G2 的"⚠️ 这个规模下真的需要吗"）：
 *    **R2 四个 secret 全缺时 `backup.yml` 走 `::warning` + `exit 0` —— 工作流显示成功**，
 *    静默降级到 30 天就消失的 Artifact。**只看成功/失败抓不住，所以必须显示字节数。**
 */
export function judgeBackup(f: BackupFacts): BackupJudgement {
  if (!f.configured) {
    return {
      tone: 'unknown',
      text: '无法判断（服务端还没配 GITHUB_TOKEN / GITHUB_REPO）',
      notes: [
        '这不是"备份正常"，是**面板没资格去看**。',
        '去 Cloudflare Pages → Settings → Variables and secrets 加 `GITHUB_TOKEN`（细粒度 PAT，只给 Actions: Read）与 `GITHUB_REPO`，然后重新部署。',
      ],
    }
  }
  if (f.lastSuccessAgoMs === null) {
    return {
      tone: 'bad',
      text: '拿不到任何一次成功的备份记录',
      notes: [
        f.lastRunAgoMs === null
          ? 'GitHub 上连一条运行记录都读不到 —— 要么 workflow 从没跑过，要么 token 的权限不够。'
          : `最近一次运行在 ${agoText(Date.now() - f.lastRunAgoMs)}，但它不是成功。`,
        '去 GitHub Actions 的 backup 运行页看那四类诊断（连不上库 / 密码不对 / pg_dump 版本不兼容 / R2 上传失败）。',
      ],
    }
  }

  /* ---- 逐条收集"补充说明"，红黄绿最后按"会不会出事"定（不是按数据干不干净） ---- */
  const notes: string[] = []
  /** 字节数：`true` 正常 / `false` 低于下限 / `null` 捞不到（**捞不到 ≠ 通过**） */
  const sizeOk = f.sizeBytes === null ? null : f.sizeBytes >= BACKUP_MIN_BYTES
  if (sizeOk === false) {
    notes.push(
      `最新一份只有 ${humanBytes(f.sizeBytes)}（低于 ${humanBytes(BACKUP_MIN_BYTES)} 的下限）—— ` +
        '疑似"**合法但空的 .gz**"那个坑（`backup.yml:9-11`：管道里 `$?` 拿到的是 gzip 的退出码，pg_dump 挂了会被吞掉，工作流还显示绿灯）。',
    )
  }
  if (sizeOk === null) {
    notes.push(
      '捞不到字节数（GitHub 的运行日志下载失败，或日志里没有那行"dump 大小"）—— ' +
        '**认不出不等于通过**：请人去看一眼那次运行的日志。',
    )
  }
  if (f.degradedToArtifact) {
    notes.push(
      '这次走的是 **Artifact 降级路径**（R2 没配）—— `backup.yml:337` 只 `::warning` 然后 `exit 0`，' +
        '所以**工作流显示的是成功**。这不是长久方案：Artifact 只保留 30 天。',
    )
  }
  const r2 = f.r2Keys ?? {}
  const has = (k: string) => r2[k] === true
  if (has('R2_ENDPOINT') && has('R2_BUCKET') && !has('R2_ACCESS_KEY_ID') && !has('R2_SECRET_ACCESS_KEY')) {
    notes.push(
      '**R2_ENDPOINT / R2_BUCKET 配了，但 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` 缺失 → 上传必然失败**' +
        '（照抄 `backup.yml:345` 的原文口径）。修法二选一：① 补上这两个 secret；② 把 `R2_ENDPOINT` 也清空，正式走 Artifact 方案。',
    )
  }

  const agoTextOfSuccess = agoText(Date.now() - f.lastSuccessAgoMs)
  if (f.lastSuccessAgoMs > BACKUP_BAD_MS) {
    return {
      tone: 'bad',
      text: `备份已 ${agoTextOfSuccess}没成功 → 这段时间内被删的数据恢复不了`,
      notes: [
        '去 GitHub Actions 手动触发一次（`workflow_dispatch` 已开，`backup.yml:20`）。',
        ...notes,
      ],
    }
  }
  if (sizeOk === false) {
    return { tone: 'bad', text: `最新一份备份只有 ${humanBytes(f.sizeBytes)}（可疑）`, notes }
  }
  if (f.degradedToArtifact) {
    return {
      tone: 'warn',
      text: '备份在跑 · **已知 · 已接受**：降级成 Artifact，**30 天后自动删除**（要留档得手动下载）',
      notes: [
        '🔴 **代价**：Artifact 只保留 30 天 —— **过期即删，不会通知**。要留档就现在**手动下载**：' +
          'GitHub → Actions → backup → 那条运行 → 页面最下面的 Artifacts。',
        '🔴 **为什么它不是"待办"**：开通 R2 要绑**国际银行卡**，当前账号做不到 → 永久状态。',
        ...notes,
      ],
    }
  }
  if (sizeOk === null) {
    return {
      tone: 'warn',
      text: `备份 ${agoTextOfSuccess}成功，但字节数捞不到（**不能算通过**）`,
      notes,
    }
  }
  if (f.lastSuccessAgoMs > BACKUP_WARN_MS) {
    return { tone: 'warn', text: `备份已 ${agoTextOfSuccess}没成功（超过 36 小时）`, notes }
  }
  return {
    tone: 'ok',
    text: `备份 ${agoTextOfSuccess}成功 · 最新一份 ${humanBytes(f.sizeBytes)}`,
    notes,
  }
}

/* ---------------- B1 / B3 配置完整性的判据 ---------------- */

export type SecretFacts = {
  /** 只有"在 / 不在"，**没有值、没有长度** */
  keys: Record<string, boolean>
  /** 服务端 Function 配置本身在不在（不在 → 整个回话拿不到东西） */
  configured: boolean
}

/**
 * 这份回话是不是**面板接口的那份 JSON**（2026-10-04 加）。
 *
 * 🔴 **为什么不能只看 HTTP 200**（apk 实测抓到的假红，用户截图报的"那几个 key 读不到"）：
 *    两个壳（exe / apk）的 origin 都不是线上域名（`app://-` / `https://localhost`）
 *    ⇒ `fetch('/api/admin/config-check')` 打到的是**壳自己的本地服务器**，而它对不认识的
 *    路径回 **200 + index.html**。于是 `r.ok === true`、`r.json()` 抛错被
 *    `.catch(() => ({}))` 咽成 `{}` ⇒ 旧逻辑判"服务端回话拿到了"、`keys` 空
 *    ⇒ 面板写「`SUPABASE_SERVICE_ROLE_KEY` 未配置」，还让超管去 Cloudflare 加 secret
 *    —— **假红，而且指引指错了地方**（真病因是那条请求根本没出壳）。
 *    这件事按 §三.4 的三态**必须是灰**："读不到"绝不许说成"没配"。
 *
 * ⚠️ 判据故意**宽松**：只要 `status === 'ok'` 且三块（config / backup / db）里至少有一块
 *    是对象就算数（`action` 不同、返回的块不同）。宁可把真回话判成"读不到"（灰），
 *    也不许把"读不到"判成"没配"（假红）。
 */
export function looksLikeServerReport(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const isObj = (x: unknown) => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
  const b = body as { status?: unknown; config?: unknown; backup?: unknown; db?: unknown }
  return b.status === 'ok' && (isObj(b.config) || isObj(b.backup) || isObj(b.db))
}

/** `SUPABASE_SERVICE_ROLE_KEY` —— 缺了会让"教师账号 / 教室端账号"那两页打不开 */
export const SERVICE_KEY_IMPACT =
  '影响：教师账号（建号 / 指派身份 / 重置密码）、教室端账号 —— 这两页会给出"还没配置账号服务"；**其他功能不受影响**'

export function judgeServiceKey(f: SecretFacts): { tone: Tone; text: string; notes: string[] } {
  if (!f.configured) {
    return { tone: 'unknown', text: '无法判断（服务端面板接口没配置）', notes: [] }
  }
  if (!f.keys.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      tone: 'bad',
      text: '`SUPABASE_SERVICE_ROLE_KEY` 未配置',
      notes: [
        SERVICE_KEY_IMPACT,
        '去 Cloudflare Pages → Settings → Variables and secrets 添加它（选 Secret），然后重新部署。',
        '改 secret 只能在 Cloudflare 控制台做，面板**不给按钮**（那是运维动作，不是可以点一下就好事）。',
      ],
    }
  }
  return { tone: 'ok', text: '账号服务：可用', notes: [SERVICE_KEY_IMPACT] }
}

/** R2 四个 secret 的名字（顺序固定，界面上一行一个） */
export const R2_KEYS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET'] as const

export function judgeR2(f: SecretFacts): { tone: Tone; text: string; notes: string[] } {
  if (!f.configured) return { tone: 'unknown', text: '无法判断（服务端面板接口没配置）', notes: [] }
  const has = (k: string) => f.keys[k] === true
  const endpoint = has('R2_ENDPOINT')
  const bucket = has('R2_BUCKET')
  const id = has('R2_ACCESS_KEY_ID')
  const secret = has('R2_SECRET_ACCESS_KEY')
  const all = endpoint && bucket && id && secret
  const none = !endpoint && !bucket && !id && !secret
  if (all) {
    return { tone: 'ok', text: 'R2 四个 secret 都在（备份走 R2，保留最近 30 份）', notes: [] }
  }
  if (none) {
    return {
      tone: 'warn',
      text: 'R2 四个都没配 —— **已知 · 已接受**：备份走 Artifact 降级，**30 天后自动删除**',
      notes: [
        '🔴 **代价写在这里，别当它不存在**：Artifact 只保留 30 天，**过期即删、不会通知**。' +
          '要留档就**手动下载**：GitHub → Actions → backup → 那条运行 → 页面最下面的 Artifacts。',
        '这不是"备份没跑"（备份**在跑**，工作流也照旧绿灯：`backup.yml` 只 `::warning` 然后 ' +
          '`exit 0`）—— 区别只在"留多久"。',
        '⚠️ 这正是面板非要有 G2 那条字节数的理由：**只看成功/失败抓不住这个状态。**',
        '🔴 **为什么它不是"待办"**：开通 R2 要绑**国际银行卡**（Cloudflare 的付款要求），' +
          '当前账号做不到 → 这是**永久状态**，不是"有个动作等着你去做"。' +
          '真正要处理的是**半配置**：`R2_ENDPOINT` / `R2_BUCKET` 配了而两个 key 没配 —— 那条照旧红。',
      ],
    }
  }
  if (endpoint && bucket && !id && !secret) {
    return {
      tone: 'bad',
      text: '**R2_ENDPOINT / R2_BUCKET 配了，但两个 key 缺失 → 上传必然失败**',
      notes: ['照抄 `backup.yml:345` 的原文口径。修法二选一：① 补上 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`；② 把 `R2_ENDPOINT` 也清空，正式走 Artifact 方案。'],
    }
  }
  return {
    tone: 'warn',
    text: 'R2 只配了一部分（半配置状态）',
    notes: [
      `在：${R2_KEYS.filter(has).join('、') || '（无）'}；不在：${R2_KEYS.filter((k) => !has(k)).join('、')}`,
      '半配置最容易骗人 —— 看起来"配过了"，实际每次上传都失败。',
    ],
  }
}

/* ============================================================
   🆕 2026-09-29 管理台第二期：三条新判据
   ------------------------------------------------------------
   分层与第一期完全一致：**纯逻辑在这里、渲染在 `Admin.tsx`**。
   阈值做成**导出常量**，因为 `admin-checks.mjs` 要逐档造用例
   （照第一期 G2 那四个阈值那一节的写法）。
   ============================================================ */

/* ============================================================
   🆕 管理台第二期：**分区导航的登记表**
   ------------------------------------------------------------
   它放在这个纯逻辑文件里（而不是 `Admin.tsx`）有两个理由：
     · `react(only-export-components)`：组件文件里导出一张常量表会让 Fast Refresh 失效；
     · 它是**可被断言的数据**：`admin-checks` 直接 import 它，逐条核对
       "分区是不是这七个、label 有没有重复" —— 比读源码文本稳。
   ⚠️ 分区**不是路由**（`/admin` 仍然只有一条裸路由，I41）——
      这七个 key 只是面板内部的一排标签页。
   ============================================================ */

export const ADMIN_SECTIONS = [
  { key: 'overview', label: '概览', hint: '数字磁贴 + 体检结论' },
  { key: 'health', label: '健康', hint: '版本 / 配置 / 结构 / 备份 / 数据' },
  { key: 'db', label: '数据库', hint: '用量、逐表体积、单份档案排行' },
  { key: 'announce', label: '公告', hint: '全站公告（关于平台本身）' },
  { key: 'maintenance', label: '维护', hint: '开关、定时、自动关闭' },
  { key: 'errors', label: '错误日志', hint: '前端异常流水（B 类隐私）' },
  { key: 'feedback', label: '反馈', hint: '老师提的意见与邮件留痕' },
] as const

export type AdminTab = (typeof ADMIN_SECTIONS)[number]['key']

/* ---------------- ① 数据库用量（配额按 **500 MB** 算 —— 免费版的库上限） ---------------- */

/**
 * 🔴 **配额 = 500 MB**（Supabase **免费版**的库上限，控制台写 0.5 GB）。
 *
 * 2026-10-07 从 1 GB 改成 500 MB：1 GB 是当初的估数，而线上跑的就是免费版
 * （控制台实测：数据库 0.053 GB / 0.5 GB）。配额写大一倍 = 百分比小一半 =
 * 同一张"让人误判"的脸 —— 用户实测那一轮就是"控制台说 11%，面板说 1.4%"。
 *
 * ⚠️ 这个常量**只在这里**：服务端 `db_usage_report()`**只量字节数、不判色**
 *    （`admin-checks` 有一条反向断言：服务端回话里**不许**出现 `quotaBytes` ——
 *    否则就是"同一个数两处实现"，改一处忘一处时面板会开始骗人）。
 */
export const DB_QUOTA_BYTES = 500 * 1024 * 1024
/** 🟡 60%：够用但该看一眼了（**三档线没动**） */
export const DB_WARN_PCT = 60
/** 🔴 85%：再写入就有失败风险（**三档线没动**） */
export const DB_BAD_PCT = 85
/**
 * 🔴 **出流量的限额 = 5 GB**（Supabase 免费版的**统一出流量**额度，按**账单周期**清零）。
 *
 * ⚠️ 与库配额同一条纪律：**只在这里** —— 服务端（`config-check.ts`）只回报
 *    "用掉多少字节"，**不许**回报限额（那会变成同一个数两处实现）。
 * ⚠️ 三档线**复用** `DB_WARN_PCT` / `DB_BAD_PCT`（60 / 85）：不新开第二套阈值 ——
 *    两个额度是同一张账单上的两个格子，阈值也要是同一套。
 */
export const EGRESS_QUOTA_BYTES = 5 * 1024 ** 3
/**
 * 🔴 **与百分比无关的一条红**：单份档案的 `question_meta` > 5 MB。
 *
 * 为什么百分比挡不住它：题图是**以 base64 直接塞进 `question_meta`（jsonb）** 的
 * （`lib/docx.ts:151`），一份档案就能到十几 MB —— 而全库可能才用了 30%。
 * 真出事的那一刻是"**这一份存不进去了**"，不是"库满了"。
 * ⚠️ 第一条链在**服务端**：`docx.ts` 的题图预算（单张 / 单份都有上限）。
 *    这一条是**第二道网**：超了就在这块屏上红给你看。
 */
export const ARCHIVE_META_BAD_BYTES = 5 * 1024 * 1024

export type DbTableFact = { name: string; bytes: number; rowsEstimate: number | null }
export type DbArchiveFact = { assignmentId: string; className: string; bytes: number }

export type DbFacts = {
  /** 服务端有没有拿到数（false = 没配密钥 / 接口没部署 → **灰**，不是绿也不是红） */
  configured: boolean
  /** 🔴 **整库**字节数（`pg_database_size`）—— **百分比按它算** */
  totalBytes: number | null
  /**
   * ⚠️ **public schema 全部表**（含索引与 TOAST），不是"前 12 名" ——
   *    面板要能算出「**用户表之和**」这个完整口径（`userTableBytes`）。
   *    🔴 它与 `totalBytes`（整库）**不是一个口径**：差的那些是系统目录 / WAL /
   *    其他 schema（auth / storage…）。两个数都要在屏上，别只显示一个。
   */
  tables: DbTableFact[]
  questionMetaBytes: number | null
  archives: DbArchiveFact[]
  /** 捞不到的原因（`null` = 拿到了）。**它是独立字段**，为 null 才允许绿 */
  unknownReason: string | null
}

export type DbJudgement = {
  tone: Tone
  /** 卡上那一句话（一般只放**一个数字**，照第一期 §3.4 的 L1 密度纪律） */
  text: string
  notes: string[]
  /** 已经用掉的百分比 —— 🔴 **按整库算**（拿不到是 null） */
  pct: number | null
  freeBytes: number | null
  /** 「用户表之和」（`tables` 全量相加）；一张表都没探到 = null（**不许掰成 0**） */
  userTableBytes: number | null
  /** 体积超标的那几份档案（**只有班级名与字节数**，没有题目内容） */
  oversized: DbArchiveFact[]
  /** 体积最大的那一份（永远显示：它是"还能不能再塞一份"的答案） */
  biggest: DbArchiveFact | null
}

/**
 * 🔴 **出流量**（Supabase Management API 取的那一份）。
 *
 * 为什么它不是 `DbFacts` 的一部分：**两件事、两个来源** —— 库大小来自数据库
 * （`db_usage_report()`），出流量来自 Supabase 的**账单周期**（数据库里量不到）。
 * 所以**读不到出流量不影响库大小那一格**，反之亦然。
 */
export type EgressFacts = {
  /** `SUPABASE_PAT` + `SUPABASE_PROJECT_REF` 在不在（不在 = **灰**，不是红、不是 0） */
  configured: boolean
  /** 本账单周期已用出流量（字节）；读不到是 **null**（**绝不掰成 0**） */
  bytes: number | null
  /** Management API 顺手报的库大小（**对账**用：与本页的整库数互相印证） */
  dbSizeBytes: number | null
  /** 本页那一格量到的**整库**字节数（`db_usage_report().totalBytes`）—— 对账的另一半 */
  wholeDbBytes: number | null
  /** 为什么读不到（**显式**；`null` = 拿到了）—— 静默成 0 正是这张卡这次的毛病 */
  reason: string | null
  /** 实际取数的端点（诊断用，**不含 PAT**） */
  source: string
  /** 账单周期起止（端点给了才有；界面用它说清"这是哪个周期"） */
  periodStart: string | null
  periodEnd: string | null
}

export type EgressJudgement = {
  tone: Tone
  text: string
  notes: string[]
  pct: number | null
}

export function judgeDbUsage(f: DbFacts): DbJudgement {
  /*
   * 「用户表之和」= `tables`（**全量** public schema）相加。
   * ⚠️ 一张都没探到 → null（**无法判断**），不许写成 0 —— "0 字节"与"没读到"是两件事。
   */
  const userTableBytes = f.tables.length
    ? f.tables.reduce((s, t) => s + (Number.isFinite(t.bytes) ? t.bytes : 0), 0)
    : null
  const none: Omit<DbJudgement, 'tone' | 'text' | 'notes'> = {
    pct: null,
    freeBytes: null,
    userTableBytes,
    oversized: [],
    biggest: null,
  }
  /* 拿不到数 → **灰**（"没结论"绝不能是红，也绝不能是绿） */
  if (!f.configured || f.totalBytes === null) {
    return {
      tone: 'unknown',
      text: '无法判断 —— 数据库用量读不到',
      notes: [
        f.unknownReason ?? '（服务端没给出原因 —— 这本身就是一条要查的事）',
        '⚠️ 读不到**不是**"还剩很多"，也**不是**"满了"。这一格永远是灰的。',
        '要它变绿：确认 `SUPABASE_SERVICE_ROLE_KEY` 在、`schema.sql` §26 跑过、接口部署上了。',
      ],
      ...none,
    }
  }
  /* 🔴 **百分比按整库算**（`f.totalBytes` = `pg_database_size`，与控制台同一口径）。
     曾经踩过的坑：按"用户表之和"算 → 面板 1.4% 而控制台 11% —— 面板显示 50% 时库早就满了。*/
  const pct = (f.totalBytes / DB_QUOTA_BYTES) * 100
  const freeBytes = Math.max(0, DB_QUOTA_BYTES - f.totalBytes)
  const oversized = f.archives.filter((a) => a.bytes > ARCHIVE_META_BAD_BYTES)
  const biggest = [...f.archives].sort((a, b) => b.bytes - a.bytes)[0] ?? null

  const head = `数据库（整库）${humanBytes(f.totalBytes)} / ${humanBytes(DB_QUOTA_BYTES)}（${pct.toFixed(1)}%）`
  const notes: string[] = [
    `剩余 ${humanBytes(freeBytes)}`,
    /*
     * 🔴 **两个口径必须都写出来**，否则屏上就是"整库 53 MB（11%）"配一张加起来才
     *    14.8 MB 的排行表 —— 看着自相矛盾（用户 2026-10-07 实测那一轮就是这样）。
     */
    userTableBytes === null
      ? '⚠️ 逐表排行这一栏没读到 → "用户表之和"也算不出来（这一格是未知，不是 0）'
      : `本页**整库** ${humanBytes(f.totalBytes)} 与逐表排行的**用户表之和** ${humanBytes(
          userTableBytes,
        )} 差 ${humanBytes(Math.max(0, f.totalBytes - userTableBytes))} —— 那不是矛盾：` +
        '差的是**系统目录 / WAL / 其他 schema**（auth / storage / realtime…），**排名表本来就只统计 public 里那些表**。',
    /* ⚠️ 交叉引用：本卡回答"全库还剩多少"，**不重复**回答"哪一份档案最大" */
    '单份档案的体积排行就在**本页明细**里（与"全库还剩多少"是两个问题：一份档案就能到十几 MB）',
    '🔴 本卡**没有任何写操作**：不给"清理题图""压缩"按钮（题图是老师拍的原始材料，删了找不回来）',
  ]
  if (biggest) {
    notes.push(
      `体积最大的那一份：${humanBytes(biggest.bytes)}（${biggest.className || '（没有班级名）'}）` +
        ` —— 它离 ${humanBytes(ARCHIVE_META_BAD_BYTES)} 的红线还有 ${humanBytes(
          Math.max(0, ARCHIVE_META_BAD_BYTES - biggest.bytes),
        )}`,
    )
  }

  /*
   * 🔴 **红的第一条：口径自相矛盾**（整库 **<=** "用户表之和" = 物理上不可能）。
   *
   * 为什么含等号：整库（`pg_database_size`）**必然严格大于** public 里的表之和
   * （系统目录、WAL、auth/storage 那些 schema 永远不为 0）。所以"**等于**"就已经是
   * 旧版口径的指纹 —— 那个函数当初就是把用户表加起来当整库报的。
   * ⚠️ 用 `>` 会漏掉最典型的那种情形（两个数一模一样），这一条就等于没写。
   *
   * 判成红而不是灰：**不是没结论，是确实不对**（数字就在那儿，只是口径错了）。
   */
  if (userTableBytes !== null && userTableBytes > 0 && userTableBytes >= f.totalBytes) {
    return {
      tone: 'bad',
      text:
        `口径不对：服务端报的整库 ${humanBytes(f.totalBytes)} 不比"用户表之和" ${humanBytes(
          userTableBytes,
        )} 大 —— 那个函数还是**旧版（只算用户表）**，百分比是偏小的`,
      notes: [
        '整库（`pg_database_size`）必然**大于** public 里那些表之和（系统目录 / WAL / 别的 schema 都不是 0）—— 相等或更小只可能是口径错了。',
        '修法：到 Supabase → SQL Editor 重跑 `schema.sql` 第 26 段（`create or replace function` 是幂等的），再回本页刷新。',
        ...notes,
      ],
      pct,
      freeBytes,
      userTableBytes,
      oversized,
      biggest,
    }
  }

  /* 红的第二条：**与百分比无关**（单份档案太大 = 这一份存不进去） */
  if (oversized.length > 0) {
    return {
      tone: 'bad',
      text: `${head} —— 但有 ${oversized.length} 份档案的题目数据 > ${humanBytes(ARCHIVE_META_BAD_BYTES)}（**单份就超预算**）`,
      notes: [
        `最大的一份 ${humanBytes(oversized[0].bytes)}（${oversized[0].className || '（没有班级名）'}）`,
        '这是一条**与百分比无关的红**：库里可能才用了 30%，但那一份档案已经写不进去了。',
        '原因：题图以 base64 直接存在 `question_meta` 里（`lib/docx.ts` 的预算只挡住新建的那些）。',
        ...notes,
      ],
      pct,
      freeBytes,
      userTableBytes,
      oversized,
      biggest,
    }
  }
  if (pct > DB_BAD_PCT) {
    return {
      tone: 'bad',
      text: `${head} —— 再写入有失败风险`,
      notes: ['先去 G2 那一条确认最近一次备份是成功的（要清东西之前，先确保有退路）', ...notes],
      pct,
      freeBytes,
      userTableBytes,
      oversized,
      biggest,
    }
  }
  if (pct >= DB_WARN_PCT) {
    return {
      tone: 'warn',
      text: `${head} —— 建议看一眼体积排行`,
      notes: [`过了 ${DB_WARN_PCT}% 就该知道"是谁占的"（明细里有逐表排行）`, ...notes],
      pct,
      freeBytes,
      userTableBytes,
      oversized,
      biggest,
    }
  }
  return {
    tone: 'ok',
    text: `${head} —— 够用`,
    notes: [
      /* 阈值是**"还能不能再塞一份档案"**的口径，不是纯百分比 */
      `还剩 ${humanBytes(freeBytes)}，按最大的一份档案（${
        biggest ? humanBytes(biggest.bytes) : '（还没量到）'
      }）算…… 够用`,
      ...notes,
    ],
    pct,
    freeBytes,
    userTableBytes,
    oversized,
    biggest,
  }
}

/**
 * 🔴 **出流量的三态**（与这张卡上"③ 备份"那一格同款）：
 *   · 没配 `SUPABASE_PAT` / `SUPABASE_PROJECT_REF` → **灰**（读不到），**不是红**；
 *   · 配了但取不回来（HTTP 错 / 回话里没有那个字段）→ **灰 + 把原因写出来**（**显式**，
 *     绝不静默成一个 0 —— 静默成 0 正是这张卡这次的毛病）；
 *   · 拿到了 → 按 5 GB 的三档线判色（阈值与库那一格共用，见 `EGRESS_QUOTA_BYTES`）。
 */
export function judgeEgress(f: EgressFacts): EgressJudgement {
  const quota = humanBytes(EGRESS_QUOTA_BYTES)
  if (!f.configured) {
    return {
      tone: 'unknown',
      text: `出流量 —— 读不到（还没配 \`SUPABASE_PAT\` / \`SUPABASE_PROJECT_REF\`）`,
      notes: [
        f.reason ?? '（服务端没给出原因 —— 这本身就是一条要查的事）',
        `⚠️ 读不到**不是**"还有 ${quota}"，也**不是**"超了"。这一格永远是灰的（与旁边"③ 备份"同款）。`,
        '要它变绿：去 Cloudflare Pages → Settings → Variables and secrets 加一个**只读**的 `SUPABASE_PAT`（Supabase → Account → Access Tokens）与 `SUPABASE_PROJECT_REF`（项目 ref，20 位小写字母），然后重新部署。',
        '🔴 面板**只回报它在不在**，**绝不回显、也不回长度** —— 这条纪律与 `GITHUB_TOKEN` 那一条逐字相同。',
      ],
      pct: null,
    }
  }
  if (f.bytes === null) {
    return {
      tone: 'unknown',
      text: `出流量 —— 读不到（${f.reason ?? '服务端没给原因'}）`,
      notes: [
        `取数端点：${f.source || '（未知）'}（Supabase Management API，只读 PAT）`,
        `⚠️ 读不到**不是**"还有 ${quota}" —— 这一格永远是灰的，**不许按 0 算**。`,
        '要它变绿：确认 PAT 没过期、`SUPABASE_PROJECT_REF` 是这个项目的 ref、PAT 至少能读用量。',
      ],
      pct: null,
    }
  }
  const pct = (f.bytes / EGRESS_QUOTA_BYTES) * 100
  const notes: string[] = [
    `本账单周期已用 ${humanBytes(f.bytes)} / ${quota}（按**账单周期**清零，不是"每月 1 号"）`,
    `来源：Supabase Management API（${f.source || '（未记录端点）'}）· 只读 PAT`,
    '⚠️ 出流量涨起来比库快：教室端大屏每次刷新都在下载数据 —— 库还没满它先满。',
  ]
  if (f.dbSizeBytes !== null && f.wholeDbBytes !== null) {
    const rel = (Math.abs(f.dbSizeBytes - f.wholeDbBytes) / Math.max(1, f.wholeDbBytes)) * 100
    notes.push(
      `对账：Management API 报的库大小 ${humanBytes(f.dbSizeBytes)} · ` +
        `本页那一格（\`pg_database_size\`）${humanBytes(f.wholeDbBytes)} —— 差 ${rel.toFixed(1)}%；` +
        '两者都是"整个库"的口径，差一点点正常（量数时刻 / WAL 记账不同），**差上一倍就要查那一格**。',
    )
  } else if (f.dbSizeBytes !== null) {
    notes.push(
      `对账：Management API 报的库大小 ${humanBytes(f.dbSizeBytes)}；本页那一格没读到 → **这次对不了账**。`,
    )
  } else {
    notes.push('Management API 这次没回报库大小 → 对不了账（**这是"少了一条印证"，不是"对上了"**）。')
  }
  if (pct > DB_BAD_PCT) {
    return {
      tone: 'bad',
      text: `出流量 ${humanBytes(f.bytes)} / ${quota}（${pct.toFixed(1)}%）—— 再超就限速`,
      notes: ['节流顺序：先看教室端大屏的刷新频率与图片体积，再看作业档案里那些大题图。', ...notes],
      pct,
    }
  }
  if (pct >= DB_WARN_PCT) {
    return {
      tone: 'warn',
      text: `出流量 ${humanBytes(f.bytes)} / ${quota}（${pct.toFixed(1)}%）—— 建议看一眼是谁在下载`,
      notes: [`过了 ${DB_WARN_PCT}% 就该知道"流量花在哪"（教室端大屏 / 题图 / 导出）。`, ...notes],
      pct,
    }
  }
  return { tone: 'ok', text: `出流量 ${humanBytes(f.bytes)} / ${quota}（${pct.toFixed(1)}%）—— 够用`, notes, pct }
}

/* ---------------- ② 前端错误日志（24 小时条数） ---------------- */

/** 🟡 出现 1 条就该看一眼（绿 = 近 24 小时一条都没有） */
export const ERRORS_WARN_24H = 1
/**
 * 🔴 30 条以上算红：这个量级基本不是"一个人偶发"，而是**一次回归**
 *    （130 人的平台，一天 30 条 = 平均每 4 个人就有一个撞上）。
 */
export const ERRORS_BAD_24H = 30

export type ErrorFacts = {
  /** 读得到吗（false = 接口没部署 / 表没建 / 没权限 → 灰） */
  readable: boolean
  total: number | null
  last24h: number | null
  /** 最近一条的时间戳（毫秒），没有就是 null */
  lastAt: number | null
  /** 最近一条的页面（用来回答"集中在哪一页"） */
  lastView: string
  unknownReason: string | null
}

export function judgeErrorLog(f: ErrorFacts): { tone: Tone; text: string; notes: string[] } {
  if (!f.readable || f.last24h === null) {
    return {
      tone: 'unknown',
      text: '无法判断 —— 错误日志读不到（接口没部署 / 第 24 段没跑 / 没权限）',
      notes: [
        f.unknownReason ?? '（服务端没给出原因）',
        '⚠️ 读不到**不是**"没有错误"。这一格永远是灰的。',
      ],
    }
  }
  const notes = [
    `历史共 ${f.total ?? '未知'} 条` + (f.lastAt ? ` · 最近一条 ${agoText(f.lastAt)}` : ' · 还没有任何一条'),
    '⚠️ 这里可能与 `syncError` 有关但不能互相替代：`syncError` 是**上一次写库失败的原因**（一个字符串槽位、没有时间没有历史），这张表是**浏览器 JS 异常的时间序列**。',
    '⚠️ 与第一期的 H 组（调用与错误 / 教室端心跳）**零重叠**：那一组是"服务端调用与设备"，这一条是"浏览器里崩了"。',
    '🔴 隐私：`message` / `stack` 里**可能夹到学生姓名** —— 属隐私三级里的 B 类，明细要点开、固定一行"请勿投屏或截图"。',
  ]
  const where = f.lastView ? `（最近一条在 ${f.lastView}）` : ''
  if (f.last24h >= ERRORS_BAD_24H) {
    return {
      tone: 'bad',
      text: `近 24 小时 ${f.last24h} 条错误${where} —— 疑似一次回归`,
      notes,
    }
  }
  if (f.last24h >= ERRORS_WARN_24H) {
    return { tone: 'warn', text: `近 24 小时 ${f.last24h} 条错误${where}`, notes }
  }
  return { tone: 'ok', text: `近 24 小时 0 条错误${where}`, notes }
}

/* ---------------- ③ 🆕 最高管理员：**有几个**（锁死成一个之后，真正要防的是 0 个） ---------------- */

/**
 * 🔴 用户 2026-10-08 拍板：「超管锁死，只能有我一个」。
 *
 * 数据库那一半是 `schema.sql` §10.1.1 ⑥ 的**部分唯一索引** `teacher_roles_one_super`
 * —— 有那条约束在，**多于 1 个是不可能的**。所以这一格**不是**"多 super 报警"：
 * 报警只能告诉你有两个，而锁死让它根本多不了。
 *
 * 🔴 它真正要防的是**另一个状态：0 个 super** ——
 *    那意味着**谁也管不了平台**（建号 / 指派身份 / 发公告 / 毕业删除全废），
 *    而它最可能的来路是**自己把自己撤了**（超管在「教师账号」里点掉自己那条身份）。
 *    这种故障**不报错**：接口一个个都还好，只是每一扇门都打不开。
 *
 * 三态（本项目最贵的一条教训：拿不到 ≠ 正常）：
 *   · 读不到（表没建 / 没权限 / 断网）→ **灰**"无法判断"，绝不画绿；
 *   · 0 个 → **红**；1 个 → **绿**；
 *   · 多于 1 个 → **红**（有约束在就不可能，所以留着这一支是防"约束被人 drop 掉了"）。
 */
export const SUPER_ADMIN_EXPECTED = 1

export type SuperAdminFacts = {
  /** 读得到吗（false = 表没建 / 读不到 / 断网 → 灰） */
  readable: boolean
  /** 库里 `teacher_roles.role = 'super'` 的行数（读不到时是 null） */
  count: number | null
  unknownReason: string | null
}

export function judgeSuperAdminCount(f: SuperAdminFacts): { tone: Tone; text: string; notes: string[] } {
  const notes = [
    '🔴 数据库那条部分唯一索引（`teacher_roles_one_super`）保证**多不了** —— 所以这一格不是报警，是**健康检查**。',
    '🔴 它防的是 **0 个**：一个都没有 = 谁也管不了平台（建号 / 指派身份 / 发公告全废），而且**不报错**。',
    '要换人：先给新的人加上，再摘自己那条（摘自己最后一条会被服务端拦住 —— 见「教师账号」那一屏的提示）。',
  ]
  if (!f.readable || f.count === null) {
    return {
      tone: 'unknown',
      text: '无法判断 —— 身份表（teacher_roles）读不到',
      notes: [
        f.unknownReason ?? '（没给出原因）',
        '⚠️ 读不到**不是**"有 1 个"，也不是"一个都没有" —— 这一格永远是灰的。',
        ...notes,
      ],
    }
  }
  if (f.count === 0) {
    return {
      tone: 'bad',
      text: '一个最高管理员都没有 —— 谁也管不了平台',
      notes: [
        "🔴 补一个的办法：在 Supabase SQL Editor 里照 `schema.sql` §10.6 的角色指派模板插一条 `role = 'super'`。",
        ...notes,
      ],
    }
  }
  if (f.count > SUPER_ADMIN_EXPECTED) {
    return {
      tone: 'bad',
      text: `有 ${f.count} 个最高管理员 —— 约束没建起来（或被人手工 drop 掉了）`,
      notes: [
        '🔴 先跑一遍 `supabase/schema.sql`（第 10.1.1 段那条部分唯一索引会自己收口，只保留最早创建的那一个）。',
        ...notes,
      ],
    }
  }
  return { tone: 'ok', text: '最高管理员 1 个（锁死：全平台只留一个）', notes }
}

/* ---------------- ③ 用户反馈（未处理数 + 邮件没发出去的数） ---------------- */

export type FeedbackFacts = {
  readable: boolean
  total: number | null
  /** 还没标记处理的条数 */
  open: number | null
  /** **邮件没发出去**的条数（`pending` / `failed` / `skipped` 都算） */
  mailBad: number | null
  unknownReason: string | null
}

export function judgeFeedback(f: FeedbackFacts): { tone: Tone; text: string; notes: string[] } {
  if (!f.readable || f.open === null) {
    return {
      tone: 'unknown',
      text: '无法判断 —— 反馈读不到（接口没部署 / 第 25 段没跑 / 没权限）',
      notes: [f.unknownReason ?? '（服务端没给出原因）', '⚠️ 读不到**不是**"没有人提过"。这一格永远是灰的。'],
    }
  }
  const notes = [
    `共 ${f.total ?? '未知'} 条 · 未处理 ${f.open} 条`,
    '⚠️ 反馈正文是**老师手写的自由文本**，很可能提到具体学生 —— 明细里固定一行"请勿投屏或截图"，`contact` 只在明细里出现。',
    '🔴 「反馈」与「通知」**方向相反**：通知是学校对老师说话，反馈是老师对学校说话 —— 两张表、两个接口，一个字都不共享。',
  ]
  /*
   * 🔴 **邮件没发出去必须红**（I51 的末句）：没配 key 时不能静默 ——
   *    否则老师提的意见躺在一个没人打开的页面里，而**双方都以为送到了**。
   */
  if (f.mailBad !== null && f.mailBad > 0) {
    return {
      tone: 'bad',
      text: `有 ${f.mailBad} 条反馈**没有发到你邮箱**（照常落库了）· 未处理 ${f.open} 条`,
      notes: [
        '为什么这算红：反馈**先落库、再发信** —— 落库那一步是成功的（所以没有丢），但**没人通知你**就等于没人看见。',
        '修法：去 Cloudflare Pages 确认 `RESEND_API_KEY` 在（面板「发测试邮件」按钮可以当场验通道）。',
        '⚠️ 别出现"双方都以为送到了"：老师那一边看到的是"已送到"（那是对的，它真的进库了）。',
        ...notes,
      ],
    }
  }
  if (f.open > 0) {
    return { tone: 'warn', text: `未处理反馈 ${f.open} 条`, notes }
  }
  return { tone: 'ok', text: `没有未处理的反馈${f.total ? `（共 ${f.total} 条，都已处理）` : ''}`, notes }
}
