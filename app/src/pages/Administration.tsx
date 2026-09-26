import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconChevronRight,
  IconSliders,
  IconTarget,
  IconUsers,
  type IconProps,
} from '../components/icons'
import { PageHead, Panel } from '../components/ui'
import { useStore } from '../data/store'
import { entryVisible, type EntryKey } from '../lib/roles'
import type { ComponentType } from 'react'

/**
 * 「行政管理」`/manage`（2026-10-01）。
 *
 * 🔴 **它是一个入口合集，不是第四个判据**：三张卡各自跳去**早就存在**的那一页，
 *    而**那三页各自的判据一个字都没动**（照旧在它们自己那里）：
 *
 *      | 卡片     | 跳去              | 那一页的入口判据（写在 `lib/roles.ts`） |
 *      |---|---|---|
 *      | 年级管理 | `/grades`         | `hasManagingRole \|\| seesTeachingData` |
 *      | 档案管理 | `/grades/promote` | `canManageTeachers`                     |
 *      | 教师管理 | `/accounts`       | `canManageTeachers`                     |
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

  return (
    <>
      <PageHead title="行政管理" sub="年级 · 档案 · 教师" onBack={() => navigate('/settings')} />
      <Page>
        <Panel className="overflow-hidden">
          {cards.map((c) => {
            const Icon = c.icon
            return (
              <button
                key={c.key}
                type="button"
                className="row"
                /* 稳定选择器（`shots.mjs` 按它点卡，不按可见文案找 —— 文案改一个字不该弄红断言） */
                data-manage-card={c.key}
                style={{ padding: 14 }}
                onClick={() => navigate(c.key)}
              >
                <span
                  className="grid place-items-center shrink-0"
                  style={{
                    width: 36,
                    height: 36,
                    border: '1px solid var(--color-line2)',
                    borderRadius: 4,
                    background: 'var(--color-surface2)',
                    color: 'var(--color-accent)',
                  }}
                >
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span style={{ fontSize: 14.5, fontWeight: 620 }}>{c.label}</span>
                  <span className="mt-0.5 block" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                    {c.desc}
                  </span>
                </span>
                <IconChevronRight size={16} />
              </button>
            )
          })}
        </Panel>
        {/*
          🔴 **这一段什么时候轮到它**：三张卡**都对这个人不摆**时 ——
          正常点不进来（`ENTRIES['/manage']` 就是那三条判据的并集），
          所以它出现只有一种情况：**手打 URL**。
          ⚠️ 那就**必须说人话**（`app/AGENTS.md` §三.5：不可写的路径要显式报错，不许静默）：
          这里没有路由守卫（这一页只是入口合集），所以这一句就是那道"看得见的说明"。
        */}
        {cards.length === 0 ? (
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
