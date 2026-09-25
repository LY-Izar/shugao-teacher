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
   C1 · `schema.sql` §10–§19 漂移总表
   ------------------------------------------------------------
   面板方案 §二 C1 的"探测手法"原文：**每条都用现成那套判据，别新写一套** ——
     · 表存在性：`select('id').limit(1)` → 看错误码（`42P01` / `PGRST205` / `schema cache`）
     · 列存在性：`select('<列>').limit(1)` → 看 `42703` / `does not exist`
     · 策略 / 函数存在性：anon key **查不到 `pg_policies`** → 标"无法判断"

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

export type DriftSection = {
  /** 段号，如 `§15` */
  stage: string
  /** 这一段建了什么（一句话） */
  built: string
  /** 不跑会怎样 —— **静默症状**，照 C1 那张表逐字写 */
  impact: string
  /** 怎么修 */
  fix: string
  state: DriftState
  cells: DriftCell[]
  /** 整份 `schema.sql` 里对应的小节（给"复制段号"用） */
  anchor: string
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
 * ⚠️ **只调"裸版"（无参 / 只吃业务参数），绝不调 `_for` 变体**：
 *    §18 的 `_for` 变体是 `revoke ... from public, anon, authenticated` 的
 *    （它们的用途是"在 SQL 编辑器里显式指定人核对"），拿 anon 会话去调会得到
 *    `permission denied` —— 那既不能证明它在、也不能证明它不在。
 *    裸版则在 §13 那句 `grant execute` 之后是可调的，且**对未登录调用恒为 false**，
 *    所以"调到并返回 false"本身就是"函数存在且判据正确"的证据。
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
    return { what, state: 'indeterminate', evidence: `${code || '?'} ${msg}`.trim() }
  } catch (e) {
    return { what, state: 'indeterminate', evidence: String(e) }
  }
}

/**
 * 各段定义。
 *
 * ⚠️ **只列面板方案 §二 C1 那张表里的 §10–§19**，没有自己发明段号：
 *    段号、建了什么、静默症状、修法**全部照抄那张表**（逐字，含它点名的行号锚点）。
 *    §1–§9 是地基，那张表自己写了"不存在『没跑』的情形"，所以不列。
 */
type SectionDef = {
  stage: string
  built: string
  impact: string
  fix: string
  anchor: string
  probes: Array<{ what: string; run: () => Promise<DriftCell> }>
}

function sectionDefs(): SectionDef[] {
  const T = (table: string) => ({ what: `\`${table}\``, run: () => probeTable(table) })
  const C = (table: string, column: string) => ({
    what: `\`${table}.${column}\``,
    run: () => probeColumn(table, column),
  })
  const R = (fn: string, args: Record<string, unknown> = {}) => ({
    what: `\`${fn}()\``,
    run: () => probeRpc(fn, args),
  })
  return [
    {
      stage: '§10',
      built: '加 5 张表（schools / grades / teacher_roles / class_subjects / classroom_accounts）+ classes.school_id/.grade_id + 回填 + visible_class_ids_for / is_classroom_account + 5 条读策略',
      impact: '身份读不到 → `loadMyRoles()` 自带兜底返回 `[]` → 界面上**不多任何入口、不报错**；`grade_id` 列不存在 → 年级主任管不着自己建的班',
      fix: '去 Supabase → SQL Editor 跑 supabase/schema.sql 第 10 段',
      anchor: 'schema.sql §10（`:355–761`）',
      probes: [T('teacher_roles'), T('class_subjects'), C('classes', 'grade_id')],
    },
    {
      stage: '§11',
      built: '6 条 `*_visible` 读策略 + 教室端两处有限写（**只加，不删**）',
      impact: '读策略缺失 → 某些人少看见行，**不报错**',
      fix: '去跑第 11 段（它只加策略，重跑幂等）',
      anchor: 'schema.sql §11（`:762–832`）',
      probes: [T('schedule_items'), T('calls')],
    },
    {
      stage: '§12',
      built: '`subjects` 字典（15 行）+ 三列 `subject_code` + 回填',
      impact: '列不存在 → 写路径**摘掉那一列**；`subject_code` 全空 → 判据退化成按显示名反查，**认不出就不匹配**',
      fix: '去跑第 12 段；跑完回填一次（§12.6 有模板）',
      anchor: 'schema.sql §12（`:833–995`）',
      probes: [T('subjects'), C('assignments', 'subject_code'), C('teachers', 'primary_subject_code')],
    },
    {
      stage: '§13',
      built: '重定义 `handle_new_user`（带异常守卫）+ `is_super_admin` / `can_manage_teachers` + 学科可见性两件套 + **重写** `assignments_visible`',
      impact: '权限函数不存在 → Function 返回 **503「去跑第 13 段」**（§13.6：**不是 403**，故意区分）',
      fix: '去跑第 13 段（跑完等十几秒让 PostgREST 刷缓存）',
      anchor: 'schema.sql §13（`:996–1344`）',
      probes: [R('is_super_admin'), R('can_manage_teachers')],
    },
    {
      stage: '§14',
      built: '**只有一行被注释的 RLS 自检 SQL**（**0 个对象**）',
      impact: '跑不跑不改变行为；但它是"每张表都开了 RLS"的判据来源',
      fix: '去跑第 14 段（一行 SQL，零对象，跑不跑都不改变行为）',
      anchor: 'schema.sql §14（`:1345–1351`）',
      probes: [T('classrooms'), T('shared_files')],
    },
    {
      stage: '§15',
      built: '加 `exams` / `exam_scores` + `can_edit_exam_for` / `can_edit_exam` + 4 条策略',
      impact: '表不存在 → `ensureExamTables()` 返回 `missing` → **考试功能整个静默变空**',
      fix: '去跑第 15 段',
      anchor: 'schema.sql §15（`:1352–1667`）',
      probes: [T('exams'), T('exam_scores'), R('can_edit_exam', { p_class_ids: [], p_subject_code: '', p_subject: '' })],
    },
    {
      stage: '§16',
      built: '6 组判据两件套 + 重写 `can_grade` + 重写 4 条读策略 + **18 条写策略** + 🔴 **删 6 条旧 `for all`**',
      impact: '只删旧策略不补新策略 → 建作业/批改/加学生**被 RLS 拒**，界面只显示"保存失败"= 刷新即丢',
      fix: '去跑第 16 段（这一段是**全仓唯一不可逆**的，跑之前先存一份 §16.6 的基线）',
      anchor: 'schema.sql §16（`:1668–2266`）',
      probes: [
        R('can_grade', { p_class_id: '00000000-0000-0000-0000-000000000000', p_subject: '' }),
        R('is_school_admin'),
        R('visible_class_ids'),
      ],
    },
    {
      stage: '§17',
      built: '三条裂缝的 restrictive 收紧：`teachers_not_classroom_*` / `schedule_classroom_scope_only` / `shared_files_not_classroom_*`',
      impact: '不跑 → 教室端账号仍能写业务表（安全裂缝）',
      fix: '去跑第 17 段',
      anchor: 'schema.sql §17（`:2267–2464`）',
      probes: [],
    },
    {
      stage: '§18',
      built: '**登记节，0 行可执行 SQL** —— 只登记 13 个 `_for` 变体',
      impact: '没有 `_for` 变体 = **这条判据不可能被验证**（I33）',
      fix: '去跑第 18 段',
      anchor: 'schema.sql §18（`:2465–2568`）',
      probes: [],
    },
    {
      stage: '§19',
      built: '`shared_files.class_ids` + GIN 索引 + 搬迁 UPDATE + 读策略 + 归属守卫 + 🔴 **重写桶的读策略**',
      impact: '不跑 → **教室端拉到的文件列表恒为空，且不报错**',
      fix: '去跑第 19 段',
      anchor: 'schema.sql §19（`:2569–2831`）',
      probes: [C('shared_files', 'class_ids'), C('shared_files', 'class_id')],
    },
  ]
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
    '这一段的产物是 **restrictive 策略**，不是表也不是函数。anon key 读不到 `pg_policies`；' +
    '硬要探只能靠"故意写一次看它报不报错"，那是**有副作用的探测** —— 面板不做。' +
    '要确认请跑 `supabase/自检.sql` 第 4 段（③ 矩阵审计）。',
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
 * （表看 `42P01`/`PGRST205`、列看 `42703`、函数看 `_for` 变体）。
 * 所以第一期**照方案的手法做、不新增接口**，代价是 §17/§18 只能标"无法判断" ——
 * 而"无法判断"恰恰是方案 §3.4 第 4 条要求的独立状态。
 */
export async function probeSchemaDrift(): Promise<{ at: number; sections: DriftSection[] }> {
  const defs = sectionDefs()
  const sections = await Promise.all(
    defs.map(async (d): Promise<DriftSection> => {
      const cells = await Promise.all(d.probes.map((p) => p.run()))
      return {
        stage: d.stage,
        built: d.built,
        impact: d.impact,
        fix: d.fix,
        anchor: d.anchor,
        state: combineCells(cells),
        cells,
      }
    }),
  )
  return { at: Date.now(), sections }
}

/** C1 卡上那一句话（红 / 灰 / 绿各自说什么） */
export function driftSummary(sections: readonly DriftSection[]): {
  state: DriftState
  text: string
  /** 未跑的段（红） */
  missing: DriftSection[]
  /** 探测本身没结论的段（灰） */
  unknown: DriftSection[]
  /**
   * **本面板按设计就探不到的段**（§17 / §18）。
   *
   * ⚠️ 它们**不参与**这张卡的红黄绿 —— 否则这张卡**永远不可能是绿的**。
   *    理由不是"通融"，而是：这两段的产物（restrictive 策略 / `_for` 变体）
   *    **连"没跑"都没法从面板上看出**（anon 读不到 `pg_policies`，`_for` 又全被 revoke），
   *    所以它们既不是绿也不是灰 —— 它们是"**这个问题不该问面板**"，
   *    要确认请跑 `supabase/自检.sql` 第 3 / 4 段。方案 §3.4 第 4 条要的是
   *    "无法判断**不能归到绿**"，而这里连"判断"这个动作都不存在。
   */
  unprobeable: DriftSection[]
  /** 灰 / 探不到那些段，各自的原因（屏上要逐条写出来，不能只说"无法判断"） */
  reasons: string[]
} {
  const missing = sections.filter((s) => s.state === 'missing')
  const unprobeable = sections.filter((s) => s.cells.length === 0)
  const unknown = sections.filter((s) => s.state === 'indeterminate' && s.cells.length > 0)
  const probed = sections.filter((s) => s.cells.length > 0)
  const reasons = [...unknown, ...unprobeable].map(
    (s) => `${s.stage}：${NO_PROBE_REASON[s.stage] ?? '这一段的产物 anon 会话探不到。'}`,
  )

  if (missing.length) {
    const s = missing[0]
    return {
      state: 'missing',
      text: `${s.stage} 未跑 → ${s.impact.split('；')[0]}`,
      missing,
      unknown,
      unprobeable,
      reasons,
    }
  }
  if (unknown.length) {
    return {
      state: 'indeterminate',
      text: `${unknown.map((s) => s.stage).join(' / ')} 探测没结论（**不是绿**）`,
      missing,
      unknown,
      unprobeable,
      reasons,
    }
  }
  if (!probed.length) {
    return {
      state: 'indeterminate',
      text: '一段都探不到（没有云端连接？）—— 不是绿',
      missing,
      unknown,
      unprobeable,
      reasons,
    }
  }
  return {
    state: 'present',
    text:
      `线上库与 schema.sql 同步（${probed.map((s) => s.stage).join(' ')} 全跑过）` +
      (unprobeable.length ? ` · ${unprobeable.map((s) => s.stage).join(' / ')} 探不到（不是绿）` : ''),
    missing,
    unknown,
    unprobeable,
    reasons,
  }
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
    return { tone: 'warn', text: '备份在跑，但降级成了 Artifact（30 天后就没了）', notes }
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
      text: 'R2 四个都没配 → 备份走 **Artifact 降级**（`::warning` + `exit 0`，**工作流照旧绿灯**）',
      notes: [
        '这不是"备份没跑"，而是"备份只留 30 天就消失"。',
        '⚠️ 这正是面板非要有 G2 那条字节数的理由：**只看成功/失败抓不住这个状态。**',
        '修法二选一：① 补上四个 secret；② 接受 Artifact 方案，但要知道它的保留期。',
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

/* ---------------- ① 数据库用量（配额按 **1 GB** 算 —— 用户拍板） ---------------- */

/**
 * 🔴 **配额 = 1 GB**（用户 2026-09-28 拍板）。
 *
 * ⚠️ 这个常量**只在这里**：服务端 `db_usage_report()`**只量字节数、不判色**
 *    （`admin-checks` 有一条反向断言：服务端回话里**不许**出现 `quotaBytes` ——
 *    否则就是"同一个数两处实现"，改一处忘一处时面板会开始骗人）。
 */
export const DB_QUOTA_BYTES = 1_073_741_824
/** 🟡 60%：够用但该看一眼了 */
export const DB_WARN_PCT = 60
/** 🔴 85%：再写入就有失败风险 */
export const DB_BAD_PCT = 85
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
  totalBytes: number | null
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
  /** 已经用掉的百分比（拿不到是 null） */
  pct: number | null
  freeBytes: number | null
  /** 体积超标的那几份档案（**只有班级名与字节数**，没有题目内容） */
  oversized: DbArchiveFact[]
  /** 体积最大的那一份（永远显示：它是"还能不能再塞一份"的答案） */
  biggest: DbArchiveFact | null
}

export function judgeDbUsage(f: DbFacts): DbJudgement {
  const none: Omit<DbJudgement, 'tone' | 'text' | 'notes'> = {
    pct: null,
    freeBytes: null,
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
  const pct = (f.totalBytes / DB_QUOTA_BYTES) * 100
  const freeBytes = Math.max(0, DB_QUOTA_BYTES - f.totalBytes)
  const oversized = f.archives.filter((a) => a.bytes > ARCHIVE_META_BAD_BYTES)
  const biggest = [...f.archives].sort((a, b) => b.bytes - a.bytes)[0] ?? null

  const head = `数据库 ${humanBytes(f.totalBytes)} / ${humanBytes(DB_QUOTA_BYTES)}（${pct.toFixed(1)}%）`
  const notes: string[] = [
    `剩余 ${humanBytes(freeBytes)}`,
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

  /* 红的第一条：**与百分比无关**（单份档案太大 = 这一份存不进去） */
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
    oversized,
    biggest,
  }
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
