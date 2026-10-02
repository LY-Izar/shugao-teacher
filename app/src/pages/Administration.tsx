import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconCalendar,
  IconChevronRight,
  IconSliders,
  IconTarget,
  IconUsers,
  type IconProps,
} from '../components/icons'
import { PageHead, Panel } from '../components/ui'
import { useStore } from '../data/store'
import { entryVisible, hasManagingRole, type EntryKey } from '../lib/roles'
import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'

/**
 * 「行政管理」`/manage`（2026-10-01）。
 *
 * 🔴 **它是一个入口合集，不是第四个判据**：每张卡各自跳去**早就存在**的那一页，
 *    而**那几页各自的判据一个字都没动**（照旧在它们自己那里）：
 *
 *      | 卡片     | 跳去              | 那一页的入口判据（写在 `lib/roles.ts`） |
 *      |---|---|---|
 *      | 年级管理 | `/grades`         | `hasManagingRole \|\| seesTeachingData` |
 *      | 档案管理 | `/grades/promote` | `canManageTeachers`                     |
 *      | 教师管理 | `/accounts`       | `canManageTeachers`                     |
 *      | 课程管理 | `/manage/course`  | `hasManagingRole`                       |
 *
 *    ⚠️ 这一页**自己不查权限**（没有守卫、没有一句 `if (角色)`）——
 *       卡摆不摆由 `entryVisible()`（唯一那张入口表）逐个卡回答；
 *       而"能不能做成"仍然由服务端与数据库判。藏入口不是安全边界。
 *
 * 🔴 **它与 `/admin`（平台运维）是两条线，别混**：
 *    · `/manage` —— **行政事务**（年级 / 档案 / 教师），读者是教务处、年级主任、办公室主任这一层；
 *    · `/admin`  —— **平台运维**（版本 / 配置 / 备份 / 结构漂移），**超管专属**，
 *      不套 `AppShell`、不套 `Guard`、不进这张卡（它仍然是「我的」页里那一行）。
 *
 * ⚠️ 它**不是**"本地演示模式下就不摆"—— 三张卡照旧按入口表摆（本地模式也看得见这一页）。
 *    要服务端的那一张（教师管理）跳过去之后，**那一页自己**会说明"现在打不开"
 *    （`TeacherAccounts.tsx` 那条服务端 403 的路），所以这里不重复拦一道。
 *
 * 🆕 2026-10-12「课程管理」—— **第四张卡**（第 3 轮落地址，第 4 轮改成跳页）：
 *    · 🔴 它与上面三张**同款**：点一下**跳到那一页**（`/manage/course`），不再就地展开。
 *      理由：平台有「同一件事两个入口」这条纪律 —— 卡是入口，页面是页面；
 *      上一轮那套"就地展开"（连同它的 `courseOpen` 状态与面板）**已经整块删掉**，
 *      不是留着代码只把卡改成链接。
 *    · 摆不摆问 `hasManagingRole()`（既有判据函数，与 `can_manage_schedule_for()` 同形）；
 *    · ⚠️ 它**仍然带 `data-course-card`**（不是 `data-manage-card`）：那个属性在这一页上的
 *      意思是"`/manage` 上**跳页**的卡片"（`shots.mjs` 的 B4 按它逐张点过去核路由、
 *      并按张数断言"这一页摆着三张卡"）。这一张的**落点**由 S27 那一节单独钉。
 */

/** 一张入口卡：跳去哪一页 + 图标 + 标题 + 一行副标题 */
type AdminCard = {
  /** 就是 `lib/roles.ts` 的入口表 key —— 摆不摆问 `entryVisible()`，不在这里写角色数组 */
  key: EntryKey
  label: string
  desc: string
  icon: ComponentType<IconProps>
}

/**
 * 三张卡（顺序 = 图上那三行的顺序：年级管理 → 档案管理 → 教师管理）。
 *
 * ⚠️ 文案纪律（`app/AGENTS.md` §七）：副标题**只回答"这里是什么"**，
 *    不解释实现、不辩护设计。所以「档案管理」那张卡写的是它管哪两件事
 *    （学年提档 · 高三毕业的备份与删除），不是"它怎么做到的"。
 */
const CARDS: AdminCard[] = [
  {
    // 名字不变（用户 2026-10-01 只改了另外两个）
    key: '/grades',
    label: '年级管理',
    desc: '开学准备：录名单 · 建班 · 班型 · 选科 · 身份',
    icon: IconUsers,
  },
  {
    // 「提档与毕业」→「档案管理」（用户 2026-10-01 拍板改名）
    key: '/grades/promote',
    label: '档案管理',
    desc: '学年提档（高一→高二→高三）· 高三毕业的备份与删除',
    icon: IconTarget,
  },
  {
    // 「教师账号」→「教师管理」（用户 2026-10-01 拍板改名）
    key: '/accounts',
    label: '教师管理',
    desc: '建号（带学科）· 任课关系 · 班主任 / 年级主任',
    icon: IconSliders,
  },
]

export default function Administration() {
  const navigate = useNavigate()
  const myRoles = useStore((s) => s.myRoles)
  /* 三张卡逐个问那张唯一的入口表（不读任何数据行 —— M1/M2/M3） */
  const cards = CARDS.filter((c) => entryVisible(c.key, myRoles))
  /*
   * 🆕 2026-10-12「课程管理」—— **第四张卡**。
   *
   * 🔴 摆不摆问的是 `lib/roles.ts` 里**既有**的那个判据 `hasManagingRole()`
   *    （最高管理员 / 教务处 / 年级主任）—— 它恰好与数据库的
   *    `can_manage_schedule_for()` 那一档同形（§38.0：超管 / 教务处全校 · 年级主任本年级）。
   *    ⚠️ 这里**没有**在页面里就地写角色数组，也没有新造判据；
   *       而"能不能改**这个班**的课表"仍然由服务端回的布尔说了算（`CourseAdmin.tsx`）。
   *    ⚠️ 它**不进** `lib/roles.ts` 的 `ENTRIES`：那张表是"入口 ↔ 左栏那一行"的登记表
   *       （`/manage/course` 自己的 `visibleFor` 已经登记在 `ENTRIES` 里、由 `App.tsx` 那一页用），
   *       而这一页只是**入口合集**，它自己的卡摆不摆由上面那句回答。
   */
  const mayCourse = hasManagingRole(myRoles)
  /*
   * 🆕 2026-10-XX「校历」—— **第五张卡**（点一下跳到 `/manage/calendar`）。
   *
   * 🔴 摆不摆问的**还是** `hasManagingRole()` 这一条 —— 就是 `ENTRIES['/manage/calendar']`
   *    用的那一句，两边不会走散（这一页只是入口合集，不新造判据、不写角色数组）。
   *    ⚠️ 与课程管理**故意同档**：看得见这一页的是管理身份，而**改得动改不动某一天**
   *       在数据库（`school_calendar_write` = `is_school_admin()`），不在这一层。
   */
  const mayCalendar = hasManagingRole(myRoles)

  return (
    <>
      {/* ⚠️ 副标题**照旧不动**（仍是「年级 · 档案 · 教师」）：它与「我的」页那一行的
          副标题是同一句话（`shots.mjs` 按它找那一行）——
          而这一页本来就是"入口合集"，它列的是**卡**，不是"这一页能做什么"的全集。 */}
      <PageHead title="行政管理" sub="年级 · 档案 · 教师" onBack={() => navigate('/settings')} />
      <Page>
        <Panel className="overflow-hidden">
          {cards.map((c) => (
            <CardShell
              key={c.key}
              icon={c.icon}
              label={c.label}
              desc={c.desc}
              /* 稳定选择器（`shots.mjs` 按它点卡，不按可见文案找 —— 文案改一个字不该弄红断言） */
              data-manage-card={c.key}
              onClick={() => navigate(c.key)}
            />
          ))}
          {/*
           * 🆕 第四张卡：**课程管理**（点一下**跳到 `/manage/course`**）。
           *
           * ⚠️ 它带的是 `data-course-card` 而**不是** `data-manage-card`：后者在 B4 那一节里
           *    与"这一页摆着三张卡"那条断言绑在一起（`/grades` · `/grades/promote` · `/accounts`），
           *    而这一张的落点由 S27 那一节**单独**钉（点它 → 地址变成 `/manage/course`）。
           *    ⚠️ 两种卡都**跳页**了，差别只剩"谁来断言它的落点"。
           */}
          {mayCourse ? (
            <CardShell
              icon={IconCalendar}
              label="课程管理"
              desc="课表：按年级看班 · 调课 · 冲突"
              data-course-card="1"
              onClick={() => navigate('/manage/course')}
              right={
                <span
                  style={{ display: 'grid', placeItems: 'center', color: 'var(--color-ink3)' }}
                >
                  <IconChevronRight size={16} />
                </span>
              }
            />
          ) : null}
          {/*
           * 🆕 第五张卡：**校历**（点一下**跳到 `/manage/calendar`**）。
           *
           * ⚠️ 带的是 `data-calendar-card` —— **不是** `data-manage-card`（B4 那一节按张数
           *    断言"这一页摆着三张卡"）、**也不是** `data-course-card`（它的落点由 S27 单独钉）。
           *    三种卡都跳页，差别只剩"谁来断言它"。
           */}
          {mayCalendar ? (
            <CardShell
              icon={IconCalendar}
              label="校历"
              desc="法定节假日 · 调休 · 学校自己改的日子（能导出表格）"
              data-calendar-card="1"
              onClick={() => navigate('/manage/calendar')}
              right={
                <span
                  style={{ display: 'grid', placeItems: 'center', color: 'var(--color-ink3)' }}
                >
                  <IconChevronRight size={16} />
                </span>
              }
            />
          ) : null}
        </Panel>
        {/*
          🔴 **这一段什么时候轮到它**：三张卡**都对这个人不摆**时 ——
          正常点不进来（`ENTRIES['/manage']` 就是那三条判据的并集），
          所以它出现只有一种情况：**手打 URL**。
          ⚠️ 那就**必须说人话**（`app/AGENTS.md` §三.5：不可写的路径要显式报错，不许静默）：
          这里没有路由守卫（这一页只是入口合集），所以这一句就是那道"看得见的说明"。
        */}
        {cards.length === 0 && !mayCourse ? (
          <Panel bodyClass="p-4">
            <div style={{ fontSize: 13, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
              你的账号看不到这一页的内容。
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-ink4)', lineHeight: 1.7 }}>
              年级管理、档案与教师管理分别由教务处 / 年级主任 / 办公室主任维护。
            </div>
          </Panel>
        ) : null}
      </Page>
    </>
  )
}

/**
 * 一张管理卡的样子 —— **四张卡共用同一处**（图标盒 / 标题 / 副标题 / 右侧那个箭头）。
 *
 * 🔴 为什么抽出来而不是各写一遍：那处内联样式里有**前景色令牌** `--color-accenttext`，
 *    而 `shots.mjs` 的 **F6-H** 是按**源码里 `color:` 前景色的处数**数出来的
 *    （`--color-accenttext` 恰好 25 处，判据会先把块注释剔掉）。复制一份卡的样子 = 那个数当场 +1 ——
 *    那时候面前只有两条路：改断言的分母（为了让门禁变绿而改绿），
 *    或者把重复的样式收成一处（**这一条**）。四张卡本来就该长得一模一样，所以选后者。
 */
function CardShell({
  icon,
  label,
  desc,
  right,
  ...rest
}: {
  icon: ComponentType<IconProps>
  label: string
  desc: string
  /** 右侧那个东西（不给就是一枚向右的箭头） */
  right?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const Icon = icon
  return (
    <button type="button" className="row" style={{ padding: 14 }} {...rest}>
      <span
        className="grid place-items-center shrink-0"
        style={{
          width: 36,
          height: 36,
          border: '1px solid var(--color-line2)',
          borderRadius: 4,
          background: 'var(--color-surface2)',
          color: 'var(--color-accenttext)',
        }}
      >
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span style={{ fontSize: 14.5, fontWeight: 620 }}>{label}</span>
        <span className="mt-0.5 block" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
          {desc}
        </span>
      </span>
      {right ?? <IconChevronRight size={16} />}
    </button>
  )
}
