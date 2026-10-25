/**
 * 插件的**只读资源**（手册 §6.1 那张表）—— 宿主代理读，插件拿不到数据库客户端。
 *
 * ============================================================================
 * 口径
 * ============================================================================
 * · 数据源是**本机的 store**（`useStore`）—— 它在远程模式由 `hydrate()` + Realtime
 *   灌着，在演示模式是种子数据。插件读到的永远是"这块屏已经同步到的那一份"，
 *   与大屏自己显示的同源；不另开一条查库的路（那会变成第二套数据真相）。
 * · `stale`（手册 §6.4）：远程模式断网时 `true`（这份可能是旧缓存）；演示模式恒
 *   `false` —— 数据就在本机，没有"旧"可言。`read` **任何情况下都不 reject**：
 *   没数据回空形状，读不出来回空形状 + `stale:true`。
 * · `asOf` 一律 `beijingNow()`（§一 时间口径）。
 * · `class.assignments` 的 `dueDate`：本平台的作业档案今天只有**布置日**这一列
 *   （`Assignment.assignDate`），先按它给；手册 §6.1 的字段名是契约、保持不变，
 *   将来平台真出现"截止日"再换数据源（P2 首个用它的插件落地时一起核）。
 *
 * ============================================================================
 * 🆕 2026-10-25：`readPluginTable()` —— 能力 `read` 的**逐张表**通路
 * ============================================================================
 * 上面那 9 个是"语义资源"（宿主算好形状）；这个函数是"读表"：
 *   · 表与列都来自 `lib/pluginTables.ts` 的 `PLUGIN_READ_TABLES`，**目录里没有的一律拒**；
 *   · 线上只 select 白名单那几列，`class` 域强制 `.eq(classCol, classId)`（数组列用 `contains`），
 *     **不接受调用方传任何过滤条件** —— 拿不到整表、也拿不到别人班的行；
 *   · 一次最多 `LIMITS.readTableRows` 行，超了截断并回 `truncated: true`；
 *   · 本地演示模式从 `useStore` 取切片，取不到回空数组（**不抛**）；
 *   · 目录外 / deny 的表抛 `E_TABLE_NOT_READABLE`（这是 bug 或越权，必须说出来）。
 */

import { useStore } from '../data/store'
import { dayState, nowMinutes, toMinutes, weekdayOf } from '../lib/schedule'
import { splitLessonTitle } from '../lib/scheduleParse'
import { subjectCodeOf, subjectCodeOfName, subjectName } from '../lib/subjects'
import { collectStats } from '../lib/assignments'
import { BAND_META, gradeStats } from '../lib/grading'
import { ranked } from '../lib/wrongbook'
import { loadDailyBundle, toDutyInput, todayDuty } from '../lib/daily'
import { isoOffset } from '../lib/date'
import { beijingNow } from '../lib/holiday'
import { pickDailyQuote } from '../lib/quotes'
import { isRemote, getSupabase } from '../lib/supabase'
import { codeErr, LIMITS } from '../lib/pluginHost'
import { PLUGIN_READ_TABLES } from '../lib/pluginTables'
import type { ResourceName } from '../lib/pluginHost'
import type { ScheduleItem } from '../data/types'

export interface ResourceResult {
  value: unknown
  stale: boolean
  asOf: string
}

/** 与教室端旧页同一窗口：往前两周 + 明天（值日生锚点要往前翻才能推出来）。 */
const DAILY_FROM = -14
const DAILY_TO = 1

const noOf = (s: { studentNo: string; serial?: string }): string => s.studentNo || s.serial || ''

/** 一节课对外的形状（手册 §4.1 的 `Slot`）。`current` 的 minutesLeft 是距**结束**。
 *  导出：壳发 `clock.onLesson` 事件（lessonStart/lessonEnd）用**同一条**换算 ——
 *  两个出口各写一遍，早晚各算出两套时间。 */
export function toSlot(it: ScheduleItem | null, kind: 'current' | 'next', m: number) {
  if (!it) return null
  const t = splitLessonTitle(it.title)
  return {
    subject: t.subject,
    subjectCode: subjectCodeOfName(t.subject) ?? '',
    start: it.start,
    end: it.end,
    minutesLeft: kind === 'current' ? toMinutes(it.end) - m : toMinutes(it.start) - m,
  }
}

export async function readResource(resource: ResourceName, classId: string): Promise<ResourceResult> {
  const asOf = beijingNow().toISOString()
  const stale = isRemote ? !navigator.onLine : false
  const s = useStore.getState()
  const klass = s.classes.find((c) => c.id === classId)
  const activeStudents = () => (klass?.students ?? []).filter((st) => st.status === 'active')

  switch (resource) {
    case 'class.roster':
      return {
        value: { students: activeStudents().map((st) => ({ id: st.id, no: noOf(st), name: st.name })) },
        stale,
        asOf,
      }

    case 'class.schedule': {
      const items = s.schedule.filter((it) => it.scope === 'class' && it.classId === classId)
      return {
        value: {
          items: items.map((it) => {
            const t = splitLessonTitle(it.title)
            return {
              weekday: it.weekday,
              start: it.start,
              end: it.end,
              subject: t.subject,
              subjectCode: subjectCodeOfName(t.subject) ?? '',
              teacherName: t.teacher,
            }
          }),
        },
        stale,
        asOf,
      }
    }

    case 'class.slotNow': {
      const now = beijingNow()
      const wd = weekdayOf(now)
      const raw = s.schedule.filter(
        (it) => it.scope === 'class' && it.classId === classId && it.weekday === wd,
      )
      const d = dayState(raw, now, wd)
      return {
        value: { current: toSlot(d.current, 'current', nowMinutes(now)), next: toSlot(d.next, 'next', nowMinutes(now)) },
        stale,
        asOf,
      }
    }

    case 'class.dailyHomework':
    case 'class.duty': {
      if (!klass) {
        return resource === 'class.duty'
          ? { value: { today: null, roster: [] }, stale, asOf }
          : { value: { rows: [] }, stale, asOf }
      }
      try {
        const b = await loadDailyBundle(classId, isoOffset(DAILY_FROM), isoOffset(DAILY_TO))
        if (resource === 'class.dailyHomework') {
          return {
            value: {
              rows: b.homework.map((h) => ({
                subject: h.subject,
                subjectCode: subjectCodeOf(h) ?? '',
                content: h.content,
                onDate: h.onDate,
                source: h.source,
              })),
            },
            stale,
            asOf,
          }
        }
        const input = toDutyInput({
          students: activeStudents(),
          anchors: b.anchors,
          calendar: b.calendar,
          classCreatedAt: klass.createdAt,
        })
        const t = todayDuty(input)
        return {
          value: {
            today: t ? { no: t.studentNo, name: t.name } : null,
            roster: activeStudents().map((st) => ({ no: noOf(st), name: st.name })),
          },
          stale,
          asOf,
        }
      } catch {
        // 读不出来按"旧缓存里的空"处理，**不 reject**（手册 §6.4：没数据不是错误）
        return resource === 'class.duty'
          ? { value: { today: null, roster: [] }, stale: true, asOf }
          : { value: { rows: [] }, stale: true, asOf }
      }
    }

    case 'class.assignments': {
      const rows = s.assignments
        .filter((a) => a.classId === classId && ranked(a))
        .map((a) => {
          const cs = collectStats(klass?.students ?? [], a)
          return {
            title: a.title,
            subject: subjectName(subjectCodeOf(a), a.subject),
            dueDate: a.assignDate,
            submitted: cs.submitted,
            total: cs.total,
          }
        })
      return { value: { rows }, stale, asOf }
    }

    /*
     * 🆕 P2 首批搬运（考试板插件）：与旧教室端 `classExams` 同一条筛选与排序 ——
     * `classIds` 含本班的最近 6 场、按日期倒序。教室端对 exams 是**零写**
     * （§15.3），这里纯读 store（远程模式由 hydrateExams 灌着）。
     * 没有考试 ⇒ 回空数组：那是"没排考试"，不是错误（§6.4）。
     */
    case 'class.exams': {
      const rows = s.exams
        .filter((e) => (e.classIds ?? []).includes(classId))
        .sort((a, b) => (a.examDate < b.examDate ? 1 : -1))
        .slice(0, 6)
        .map((e) => ({
          examDate: e.examDate,
          subject: e.subject || e.title,
          status: e.status === 'graded' ? 'graded' : 'pending',
        }))
      return { value: { rows }, stale, asOf }
    }

    /*
     * 🆕 P2 收尾（讲评插件）：已批改作业 + 逐题正确率。
     *
     * 判据全部**照旧页那一份**，一个字没改：
     *   · 「已批改」= `ranked(a)`（不是 `status === 'graded'`）—— 极简模式的档案没有逐题
     *     数据，自己写状态判断会让它混进来，然后被渲染成「全班全对 + 错误率 0%」
     *     （W16 的教室端那一半，见旧页 `graded` 的注释）；
     *   · 逐题统计 = `gradeStats(本班在读学生, 档案)`，错误率 = 错的人数 ÷ 应交人数；
     *   · 排序 = 布置日倒序（旧页 `graded` 的同一行）。
     *
     * ⚠️ 为什么把**所有**已批改档案的逐题统计一次递出去：`data.read` 没有参数
     *    （手册 §4.1），插件选不了"只读第 N 份"。本班 ~45 人 × 一学期几十份作业，
     *    一次算完是毫秒级；真到算不动的时候再拆资源，别现在把接口改成带参数的。
     * ⚠️ `bandLabel` / `bandColor` 也由宿主递（`BAND_META` 里只有一份）：插件是单文件、
     *    不许 import 宿主模块（手册 §11.3），让它自己抄一张分档表就是两个真相。
     */
    case 'class.gradedHomework': {
      const students = klass?.students ?? []
      const rows = s.assignments
        .filter((a) => a.classId === classId && ranked(a))
        .sort((x, y) => (x.assignDate < y.assignDate ? 1 : -1))
        .map((a) => {
          const st = gradeStats(students, a)
          const cs = collectStats(students, a)
          return {
            id: a.id,
            title: a.title,
            subject: subjectName(subjectCodeOf(a), a.subject),
            assignDate: a.assignDate,
            total: cs.total,
            submitted: cs.submitted,
            missing: cs.missing,
            questions: st.questions.map((q) => ({
              seq: q.seq,
              wrongCount: q.wrongCount,
              rate: q.rate,
              band: q.band,
              bandLabel: BAND_META[q.band].label,
              bandColor: BAND_META[q.band].color,
              /* 学号（不是姓名）：与旧页 `PipPanel` 的 `wrongNos` 同一口径，
                 姓名由插件经 `class.roster` 自己配（名单是另一个能力）。 */
              wrongNos: q.wrongNos,
            })),
          }
        })
      return { value: { rows }, stale, asOf }
    }

    /*
     * 🆕 P2 首批搬运（祝福语插件）：宿主侧唯一话术源是 `lib/quotes.ts` 的 43 句
     *    （用户 2026-09-29 拍板的"每条能考据"那批）—— 插件不许 import 宿主内部模块
     *    （手册 §11.3），所以走资源口把**当天的那一句**递出去。`pickDailyQuote`
     *    用北京时间日期做种子，同一天固定，跨时区不串天 —— 与旧教室端
     *    `DailyQuote` 同一条判据，一个字没改。
     */
    case 'class.quote':
      return { value: { ...pickDailyQuote(beijingNow()) }, stale, asOf }
  }
}

/**
 * 读表通路（能力 `read`，手册 §6.1.1）。返回形状与语义资源一致：
 * `{ value: { rows, truncated? }, stale, asOf }`。
 *
 * 🔴 目录外的表 / `deny` 的表 ⇒ **抛** `E_TABLE_NOT_READABLE`（带一句人话 why）。
 *    其余读不到（断网、库还没跑这一段 SQL）一律回空数组 + `stale: true`，**不 reject** ——
 *    与 `readResource` 同一条口径（手册 §6.4：没数据不是错误）。
 */
export async function readPluginTable(table: string, classId: string): Promise<ResourceResult> {
  const asOf = beijingNow().toISOString()
  const def = PLUGIN_READ_TABLES[table]
  if (!def) throw tableErr(`可读目录里没有这张表：${table}`)
  if (def.deny) throw tableErr(def.deny)
  if (!def.cols.length) throw tableErr(`这张表没给任何列：${table}`)

  const stale = isRemote ? !navigator.onLine : false
  if (!isRemote) {
    /* 演示模式也守同一个行数上限：本地少给几行没关系，形状不能与线上不一样。 */
    const all = localRows(table, classId)
    const truncated = all.length > LIMITS.readTableRows
    return {
      value: truncated ? { rows: all.slice(0, LIMITS.readTableRows), truncated: true } : { rows: all },
      stale: false,
      asOf,
    }
  }

  const sb = getSupabase()
  if (!sb) return { value: { rows: [], truncated: false }, stale: true, asOf }

  /* 只读白名单列 —— 隐私列不是"读回来再删"，是压根不在 select 里。
     class 域强制按本班过滤；`class_ids` 是数组列（一场考试覆盖多个班），用 contains。 */
  let q = sb.from(table).select(def.cols.join(','))
  if (def.scope === 'class' && def.classCol) {
    q =
      def.classCol.endsWith('_ids')
        ? q.contains(def.classCol, [classId])
        : q.eq(def.classCol, classId)
  }

  const { data, error } = await q.limit(LIMITS.readTableRows + 1)
  if (error) {
    /* 库还没跑这一段 SQL / 断网：回空形状 + stale，别把插件炸掉（与语义资源同一条纪律）。
       但要留一条日志 —— "失败了没人知道"是这个项目反复踩的坑。 */
    console.warn('[plugin] 读表失败：', table, error.message)
    return { value: { rows: [], truncated: false }, stale: true, asOf }
  }

  const all = (data ?? []) as unknown[]
  const truncated = all.length > LIMITS.readTableRows
  const rows = truncated ? all.slice(0, LIMITS.readTableRows) : all
  return { value: truncated ? { rows, truncated: true } : { rows }, stale, asOf }
}

/** 目录外 / 隐私表的错：带 `code`，`why` 写进 message（审核与排错都要能读到这句）。 */
function tableErr(why: string): Error & { code: string } {
  const e = codeErr('E_TABLE_NOT_READABLE')
  e.message = `E_TABLE_NOT_READABLE: ${why}`
  return e
}

/**
 * 本地演示模式：从 `useStore` 取对应切片，**按表列名**投影（线上由 PostgREST 的列投影做同一件事）。
 * 取不到的切片就回空数组 —— 演示模式少一块数据，不该让插件以为"发生了错误"。
 */
function localRows(table: string, classId: string): unknown[] {
  const s = useStore.getState()
  const klass = s.classes.find((c) => c.id === classId)
  const iso = (t: number | null | undefined) => (typeof t === 'number' ? new Date(t).toISOString() : null)

  switch (table) {
    case 'classes':
      return s.classes
        .filter((c) => c.id === classId)
        .map((c) => ({ id: c.id, name: c.name, grade: c.grade, year: c.year }))

    case 'students':
      return (klass?.students ?? []).map((st) => ({
        id: st.id,
        class_id: classId,
        student_no: noOf(st),
        name: st.name,
        status: st.status,
      }))

    case 'assignments':
      return s.assignments
        .filter((a) => a.classId === classId)
        .map((a) => ({
          id: a.id,
          class_id: a.classId,
          title: a.title,
          subject: a.subject,
          assign_date: a.assignDate,
          question_count: a.questionCount,
          status: a.status,
        }))

    case 'schedule_items':
      return s.schedule
        .filter((it) => it.scope === 'class' && it.classId === classId)
        .map((it) => ({
          id: it.id,
          class_id: it.classId ?? '',
          weekday: it.weekday,
          start_time: it.start,
          end_time: it.end,
          title: it.title,
          room: it.room ?? '',
          kind: it.kind,
          scope: it.scope,
        }))

    case 'classrooms':
      return s.classrooms
        .filter((c) => c.classId === classId)
        .map((c) => ({
          id: c.id,
          class_id: c.classId,
          name: c.name,
          online: c.online,
          last_seen_at: iso(c.lastSeenAt),
        }))

    case 'calls':
      return s.calls
        .filter((c) => c.classId === classId)
        .map((c) => ({
          id: c.id,
          class_id: c.classId,
          assignment_id: c.assignmentId,
          student_nos: c.studentNos,
          text: c.text,
          room: c.room,
          sent_at: c.sentAt.map((t) => new Date(t).toISOString()),
        }))

    case 'exams':
      return s.exams
        .filter((e) => e.classIds.includes(classId))
        .map((e) => ({
          id: e.id,
          title: e.title,
          subject: e.subject,
          subject_code: e.subjectCode,
          scope: e.scope,
          grade: e.grade,
          exam_date: e.examDate,
          question_count: e.questionCount,
          class_ids: e.classIds,
          status: e.status,
          graded_at: iso(e.gradedAt),
        }))

    case 'exam_scores':
      /* 只投影判定列：本地也不许把 scores / answers / total 顺手递出去。 */
      return s.examScores
        .filter((r) => r.classId === classId)
        .map((r) => ({
          exam_id: r.examId,
          class_id: r.classId,
          student_no: r.studentNo,
          graded: r.graded,
          absent: r.absent,
        }))

    case 'grades':
      return s.grades.map((g) => ({ id: g.id, name: g.name, year: g.year }))

    case 'terms':
      return s.terms.map((t) => ({
        id: t.id,
        half: t.half,
        start_date: t.startDate,
        end_date: t.endDate,
      }))

    case 'notices':
      return s.notices.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        scope_kind: n.scopeKind,
        expires_at: iso(n.expiresAt),
        pinned: n.pinned,
        revoked_at: iso(n.revokedAt),
        created_at: iso(n.createdAt),
      }))

    case 'announcements':
      return s.announcements.map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        level: a.level,
        popup: a.popup,
        pin: a.pin,
        active_from: iso(a.activeFrom),
        active_to: iso(a.activeTo),
        revoked_at: iso(a.revokedAt),
        created_at: iso(a.createdAt),
      }))

    case 'schedule_temp_changes':
      return s.tempScheduleChanges
        .filter((c) => c.classId === classId)
        .map((c) => ({
          id: c.id,
          on_date: c.date,
          weekday: c.weekday,
          class_id: c.classId,
          start_time: c.start,
          end_time: c.end,
          from_subject: c.fromSubject,
          to_subject: c.toSubject,
          kind: c.kind,
          status: 'active',
          revoked_at: null,
        }))

    /* 其余表（通知投递范围、选科、校历、每日作业…）在演示模式下没有 store 切片，
       或者是服务端算出来的 —— 回空数组，**不抛**。 */
    default:
      return []
  }
}

/**
 * 订阅"变了"。回调**只表示变了、不推数据**（手册 §6.2），插件回调里自己重新 `read`。
 * P0b 从宽：store 任何一格变化都通知（重画是插件自己的便宜操作）；
 * 按资源做细粒度 diff 是 P2 有真插件之后的事，别提前做。
 */
export function watchResource(cb: () => void): () => void {
  return useStore.subscribe(() => cb())
}
