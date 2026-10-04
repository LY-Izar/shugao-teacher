/* ============================================================
   「导出档案备份（加密）」+「导出本机备份并发一封通知邮件」—— **这两颗从「我的」撤下来了**
   ------------------------------------------------------------
   用户 2026-10-04 对「我的 → 备份与恢复」那一张卡的取舍（原话）：
     「保留第一个和第四个按钮就好了，把下面的说明也删除了」
     ＋「至于全平台的备份，仅在超管面板里面留就好了」。

   于是那一屏只剩「导出备份文件」与「从备份文件恢复」；
   **加密档案导出**与**全平台那一层**搬进 `/admin` 的「③ 备份（G2）」卡
   （`pages/Admin.tsx`，2026-10-04 接线 —— 那颗按钮原来叫「备份到云端」）。

   🔴 **「备份到云端」那个名字是假的，别再叫回去**（2026-10-04 查实）：
      它**不上传任何文件**。按下去只有两件事：
        ① `splitExport()` → `downloadJson()`：把**本机明文 JSON** 存到这台设备上
           （档案不在这一份里，见下面那颗加密导出）；
        ② `notifyBackupDone()` → `/api/mail {action:'backup'}`：给**超管发一封通知邮件**
           （`functions/api/mail.ts` 的 backup 那一支 —— 只发信，邮件里不带文件）。
      「云端」只出现在**通知邮件的去向**上，跟备份文件落在哪里毫无关系。
      ⇒ 现在叫「导出本机备份并发一封通知邮件」；状态标记那四档也一律不许说"云端"。

   🔴 **别在旁边再写第二份**：`/admin` 那边直接
      `import { BackupExtraActions } from '../components/BackupExtraActions'` 摆进那张卡即可
      —— 这两颗按钮的等待态、终态、失败话术都只有这一处实现
      （同一个东西两套实现，正是这个仓库反复栽过的那类坑）。
   ⚠️ 组件自带 `flex flex-col gap-2` 那一列：容器直接摆 `<BackupExtraActions />` 就行。

   ⚠️ `shots.mjs` 的 S25 ②/③ 仍然钉着这里面的终态接线（判据只换过锚点，一个字没放宽）——
      那正是"撤下入口 ≠ 撤下实现"的证据。
   ⚠️ 🔴 **这一处也不收钥匙**：整库口令（`BACKUP_ENCRYPTION_PASSPHRASE`）与档案私钥
      都留在超管手上，界面里**没有**任何口令 / 私钥的输入框或上传口。
   ============================================================ */

import { useEffect, useRef, useState } from 'react'
import { Button } from './ui'
import { IconLock, IconSend } from './icons'
import { StatusMark, STATUS_MARK_HOLD_MS, type StatusMarkStatus } from './StatusMark'
import {
  backupSummary,
  downloadJson,
  notifyBackupDone,
  splitExport,
} from '../lib/backup'
import { sealForAdmin } from '../lib/backupCrypto'
import { useStore, useToast } from '../data/store'
import { beijingNow, ymdOf } from '../lib/holiday'

/**
 * 那颗状态标记四档各自的文案（见下面 `backupMark` 那处注释）。
 * ⚠️ `done` / `failed` **必须与 `pending` / `running` 不同** —— 否则同一句话
 *    会配着绿勾（或红叉）显示，一句文案说了两件事。
 * 🔴 **四档都不许说"云端 / 备份到云端"**：这一颗不发任何文件出去（见文件头）。
 *    `pending` 就是那颗按钮的名字，四个字一句假话都不留。
 */
const BACKUP_MARK_LABEL: Record<StatusMarkStatus, string> = {
  pending: '导出本机备份并发一封通知邮件',
  running: '正在导出，并发送通知…',
  done: '已导出 · 通知邮件已发出',
  failed: '导出或通知失败',
  cancelled: '已取消',
}

export function BackupExtraActions() {
  const push = useToast((s) => s.push)
  /** 🆕 备份通知（邮件）正在发 */
  const [bkNotifyBusy, setBkNotifyBusy] = useState(false)
  /**
   * 「导出本机备份并发一封通知邮件」那颗状态标记的**四档**
   * （`pending` → `running` → `done` / `failed`）。
   *
   * 🔴 为什么不能从 `bkNotifyBusy` 推：那个布尔量只说"忙不忙"，
   * **说不出"成了还是没成"** —— 而绿勾与红叉恰恰是这一档的全部信息量。
   * 所以终态由**真的结果**（`res.ok`）决定，不是"忙完了就当成功"。
   * （StatusMark 自己不会结束：原版组件里没有任何定时器，`running` 会一直转，见组件文件头。）
   */
  const [backupMark, setBackupMark] = useState<StatusMarkStatus>('pending')
  /** 终态那 1.2 秒的计时器：离开这一屏就别再 setState */
  const backupMarkTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(backupMarkTimer.current), [])

  return (
    <div className="flex flex-col gap-2">
      {/*
        🆕 2026-10-03：**档案那份单独导出、用超管的公钥封起来**
          （用户原话："人人可点，但是能不能加密？就是只有找超管才能解开"）。

        ⚠️ 为什么不能"顺手一起导"：明文文件是可以被转发、被丢进网盘、被留在
           下载目录里的，而这两张表是**家长电话 + 家庭住址 + 老师住址**。
        ⚠️ 加密失败（设备不是安全上下文 / 没有 WebCrypto）**必须说出来**，
           `sealForAdmin` 是 fail-closed 的 —— 绝不静默退回明文。
        ⚠️ 顺序：两次下载**必须顺序 await**（壳里是两次"另存为"模态，见 fileOut.ts 文件头）。
      */}
      <Button
        block
        icon={<IconLock size={16} />}
        data-backup-seal
        onClick={async () => {
          const r = await splitExport(useStore.getState())
          const nStu = r.profiles.studentProfiles.length
          const nTea = r.profiles.teacherProfiles.length
          if (!nStu && !nTea) {
            push({
              text: '没有可加密的档案',
              tone: 'warn',
              ...(r.issues.length
                ? { desc: r.issues[0] }
                : { desc: '这台设备读不到学生 / 教师档案（教室端账号读不到档案，这是正常的）' }),
            })
            return
          }
          try {
            const sealed = await sealForAdmin(r.profiles)
            /* 🔴 同「导出备份文件」：**拿到结果再说"已导出"**（2026-10-04）。
               apk 上存不下去时，这里原来照样报 ok —— 而这份是**档案**，
               老师以为封存好了就不再管，损失更难补。 */
            const saved = await downloadJson(sealed, `树高备份-档案-加密-${ymdOf(beijingNow())}.json`)
            if (saved === 'failed') {
              push({
                text: '档案文件没保存下来',
                tone: 'bad',
                desc: '这台设备存不了文件，换个方式导出（或到别的设备上导）。',
              })
              return
            }
            if (saved === 'cancelled') {
              push({ text: '已取消保存', tone: 'warn' })
              return
            }
            push({
              text: `已导出加密档案：学生 ${nStu} 条 / 教师 ${nTea} 条`,
              tone: 'ok',
              desc: '这份文件只有超管的私钥能解开；换设备时先恢复业务数据那份，档案仍从云端回来',
            })
          } catch (e) {
            push({
              text: '档案没能加密导出',
              tone: 'bad',
              desc: e instanceof Error ? e.message : String(e),
            })
          }
        }}
      >
        导出档案备份（加密）
      </Button>
      {/*
        🆕 2026-09-29 管理台第二期：「**毕业备份**」那条链的落点
           —— 备份 → 发信 → **发不出去就不许删**。

        ⚠️ 为什么要有这个按钮：备份通知邮件是"毕业归档 / 换账号搬数据"这类
           一次性动作的留痕。没有它，那条链只有在真出毕业那件事时才第一次运行
           —— 而它没跑通过的东西，不该压在一次不可逆的操作上。
        ⚠️ 发信失败时**必须显式说"先别删那份文件"**（这就是"不许删"的落地）。
        🔴 **它原来叫「备份到云端」，2026-10-04 改名**（用户要求"如实的名字"）：
           它不上传任何文件 —— 只导出**本机明文 JSON** + 给超管**发一封通知邮件**，
           所以四个字都不能叫"云端"（见文件头那两条事实）。
      */}
      <Button
        block
        icon={<IconSend size={16} />}
        disabled={bkNotifyBusy}
        data-backup-notify
        onClick={async () => {
          /*
           * 与「导出备份文件」同一个入口。
           * 🔴 2026-10-03：档案**不在这一份里**（`splitExport().plain` 两张表是空的）。
           *    这里之所以仍然读档案，只为了"读不到就说出来"，而不是为了把它写进明文文件。
           */
          const r = await splitExport(useStore.getState())
          /*
           * 🔴🔴 **存没存下来要先知道，再决定邮件和提示怎么说**（2026-10-04）
           *   旧版是 `downloadJson(...)` 后**无条件**走下面两句，而那两句里有一句是
           *   **发进邮箱的**「本机备份已导出」—— 那是**留痕**，假的比屏上的更难撤回。
           *   老师收到邮件就以为本机有那份文件了 ⇒ 需要恢复那天才发现没有。
           */
          const saved = await downloadJson(r.plain, `树高备份-${ymdOf(beijingNow())}.json`)
          setBkNotifyBusy(true)
          window.clearTimeout(backupMarkTimer.current)
          setBackupMark('running')
          if (saved === 'failed') {
            setBkNotifyBusy(false)
            setBackupMark('failed')
            push({
              text: '文件没能保存下来',
              tone: 'bad',
              desc: '这台设备存不了文件 —— 换个方式导出再试。',
            })
            return
          }
          const res = await notifyBackupDone(`本机备份已导出：${backupSummary(r.plain)}`, `文件：树高备份-${ymdOf(beijingNow())}.json`)
          setBkNotifyBusy(false)
          /* 🔴 终态取**真结果**：`res.ok` 是绿勾、否则红叉（红叉停住不回到 `pending`） */
          setBackupMark(res.ok ? 'done' : 'failed')
          if (res.ok) {
            push({
              text: '本机备份已导出 · 通知邮件已发出',
              tone: 'ok',
              ...(r.issues.length ? { desc: `档案没能读到（${r.issues[0]}）—— 业务数据这份是全的` } : {}),
            })
            /* ✅ 绿勾亮满 `STATUS_MARK_HOLD_MS` 再回到常态（时长只有共享常量那一处） */
            backupMarkTimer.current = window.setTimeout(
              () => setBackupMark('pending'),
              STATUS_MARK_HOLD_MS,
            )
          } else {
            /* 🔴 **不发假成功**：没存上就说没存上，并把"不许删"讲清楚。
               ⚠️ 走到这里说明**文件已经存下来了**（存不下来在上面那条就 return 了）——
                  失败的是**那封通知邮件**，所以话要落在"信没发出去"，别写成"没存上"。 */
            push({
              text: '本机备份已导出，但通知邮件没发出去',
              tone: 'warn',
              desc: `${res.message}。刚才那份文件还在本机，先别删`,
            })
          }
        }}
      >
        {/* StatusMark 是**替换**那句 `{busy ? '正在备份…' : '备份到云端'}` —— 这一处是
            全站最长的等待（导出整库 + 发通知邮件，秒级到十秒级），原来十秒里屏幕上没有
            任何"还活着"的迹象。`cancelled` 那一档**不给 `--color-bad`**（照原版）。
            ⚠️ 文案按四档给全（`done` / `failed` 各自不同），否则"正在导出…"会
                配着绿勾/红叉显示，等于一句话说两件事。 */}
        <StatusMark
          status={backupMark}
          size={16}
          label={BACKUP_MARK_LABEL[backupMark]}
          /* 🔴 `strike={false}`：平台气质偏克制，那个删除线表达的是"作废"，
             而这两处说的都是"跑完了" —— 见组件文件头。 */
          strike={false}
          style={{ justifyContent: 'center' }}
        />
      </Button>
    </div>
  )
}

export default BackupExtraActions
