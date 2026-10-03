/* ============================================================
   档案那份的封存与解开 —— **超管公钥加密，只有超管能解开**
   ============================================================

   用户口径（2026-10-03 拍板）：**人人可点导出，但档案那份只有超管能解。**
   —— 拆法：业务数据（班级 / 学生 / 作业 / 课表 / 呼叫 / 教室端）仍然明文导出，
      老师自己能拿去「从备份文件恢复」；**两张档案表**（家长电话 / 家庭住址 /
      教师住址）单独成一份、封在超管公钥里。

   🔴 为什么不是"口令"（对称）：
      口令必须发给每一个要恢复的老师 —— 一旦发出去就不再是"只有超管"，
      而口令写进客户端代码等于公开。**公钥加密**能做到"谁都能封、只有一把钥匙能开"。

   🔴 为什么公钥在**代码里**而不是数据库里：
      · 导出必须**离线可用**（教室里断网也要能导），读数据库的公钥就把它绑在网络上了；
      · 公钥写进代码之后，能改它的只有"能改代码 + 能发布"的人 —— 那是已经输了的场景；
      · 于是**轮换 = 改这一处常量 + 重新发版**（配方见 `功能设计与不变量.md` §87）。

   🔴 私钥在**超管自己手里**（密码管理器 / 离线文件），**不进仓库、不进聊天、不进数据库**。
      解在 `/admin` 里做：私钥只在那一个页面的内存里过一遍，**不上传任何地方**。

   信封格式（一个普通 JSON，可当文件传阅）：
     { fmt:'shugao-admin-sealed', v:1, alg:'RSA-OAEP-256+A256GCM', kid, at, n, wrappedKey, iv, ct }
     正文用随机 AES-256-GCM 对称密钥加密；那把密钥（DEK）再用 **RSA-OAEP-SHA256**
     封在超管公钥里（RSA 一次只能封几十字节，大文件必须走"混合加密"）。
     ⚠️ `wrappedKey` / `ct` 都绑了 AAD（`fmt|kid`）——有人把 `kid` 改成别的值也打不开。

   ⚠️ **没有 `crypto.subtle` 就失败**（不是安全上下文：老浏览器 / 非 https 的局域网地址）。
      这一处必须**明确报错**：静默退回"明文导出"正是这条设计要防的事。
   ============================================================ */

import type { StudentProfile } from './studentProfile'
import type { TeacherProfile } from './teacherProfile'

/** 信封上的格式标记（与 `Backup.v` 无关：档案信封**不是**一份备份） */
export const ADMIN_SEAL_FMT = 'shugao-admin-sealed'

/**
 * 这把超管公钥的短指纹（SHA-256(SPKI) 的前 16 个十六进制字符）。
 * 只用来说"这份文件是哪把钥匙封的" —— 轮换之后靠它分辨，不是安全判据。
 */
export const ADMIN_KEY_ID = 'a56e2be862ec838c'

/**
 * **超管公钥**（SPKI base64，RSA-OAEP-3072 / SHA-256）。
 * 生成于 2026-10-03，私钥存在超管的密码管理器里（`超管档案备份私钥.pem`）。
 * 🔴 只能整段替换（轮换），**不许**在这里写任何私钥材料。
 */
const ADMIN_PUBLIC_KEY_B64 =
  'MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAzHhAOuuizVs1NZ5vtb/KQDPttvJbR/8gG8n1FNtSnSL5gHo0fmJDdT4XoAlztmBhWDmEDriXu4IvrYAVECyODNotoqHUS0MVprm1EclwxeYyNpPIJVS+lD4ulyQcwiA6aUM6eTB4OgV6FOM0pr5PQZuush6XIN/HukOPr3UH40OppuLvJYxsn3Yaj78XMisTP1wdjcEMUR4zC/a9s22thl0/Gmdd79rgOWlWmcOwrFucxmxZ+jvc0R5E7Do+pe3E1dWfn6OniBPZsKlTMdtObAjIs8dGxNeZ/UXwORb42YC5SCgvZ4NYwwE/U/jOu2IXZlgcvXCsXtkckHLZGgKs+W2RS9DG667A95imU1zYoSO8GWZSgPIxai0+qY6ioEjyROzvc1YXzTzkqhPOHeVgsgEzLWFwoFvXP4ygMEJtqXWRfgQ8yOvP/P05LUHa8vDrVP1uFPJwnagOoqEa73h14FZMeofd3qkm0gkVioQiYu3vel2xpsvIBvvlwG0U/WLNAgMBAAE='

/** 信封本体（外面那层，可以明文传阅；里面的 `ct` 才是档案） */
export type AdminSealed = {
  fmt: typeof ADMIN_SEAL_FMT
  v: 1
  alg: 'RSA-OAEP-256+A256GCM'
  /** 哪把公钥封的（`ADMIN_KEY_ID`） */
  kid: string
  /** 封存时刻（北京时间那一瞬的 ISO） */
  at: string
  /** 里面有几行（给超管一眼看出"这份是不是空的"） */
  n: { studentProfiles: number; teacherProfiles: number }
  wrappedKey: string
  iv: string
  ct: string
}

/** 信封里的正文 */
export type AdminSealedPayload = {
  app: string
  at: string
  studentProfiles: StudentProfile[]
  teacherProfiles: TeacherProfile[]
}

/* ---------------- base64（大数组要分段，别用展开运算符一次性塞） ---------------- */

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** 私钥可能是 PEM（带 `-----BEGIN PRIVATE KEY-----`）也可能只有 base64 正文，两种都收 */
function pemToBytes(pem: string): Uint8Array<ArrayBuffer> {
  return fromB64(pem.replace(/-----[^-]+-----/g, ''))
}

function subtleOf(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) {
    throw new Error('这台设备不能加密（不是安全上下文）—— 请在 https 或应用内导出')
  }
  return c.subtle
}

/** 判据只认 `fmt`：`validateBackup` 那一路会把它当"版本不认识"，这里要先认出来 */
export function isAdminSealed(v: unknown): v is AdminSealed {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    o.fmt === ADMIN_SEAL_FMT &&
    typeof o.wrappedKey === 'string' &&
    typeof o.iv === 'string' &&
    typeof o.ct === 'string'
  )
}

/** 封存（谁都能调；没有私钥谁也打不开） */
export async function sealForAdmin(payload: {
  studentProfiles: StudentProfile[]
  teacherProfiles: TeacherProfile[]
}): Promise<AdminSealed> {
  const sub = subtleOf()
  const c = globalThis.crypto
  const pub = await sub.importKey(
    'spki',
    fromB64(ADMIN_PUBLIC_KEY_B64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  )
  const dek = c.getRandomValues(new Uint8Array(32))
  const iv = c.getRandomValues(new Uint8Array(12))
  const aad = new TextEncoder().encode(`${ADMIN_SEAL_FMT}|${ADMIN_KEY_ID}`)
  const body: AdminSealedPayload = {
    app: '树高教务通',
    at: new Date().toISOString(),
    studentProfiles: payload.studentProfiles,
    teacherProfiles: payload.teacherProfiles,
  }
  const aes = await sub.importKey('raw', dek, { name: 'AES-GCM' }, false, ['encrypt'])
  const ct = new Uint8Array(
    await sub.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      aes,
      new TextEncoder().encode(JSON.stringify(body)),
    ),
  )
  const wrappedKey = new Uint8Array(await sub.encrypt({ name: 'RSA-OAEP' }, pub, dek))
  return {
    fmt: ADMIN_SEAL_FMT,
    v: 1,
    alg: 'RSA-OAEP-256+A256GCM',
    kid: ADMIN_KEY_ID,
    at: new Date().toISOString(),
    n: {
      studentProfiles: payload.studentProfiles.length,
      teacherProfiles: payload.teacherProfiles.length,
    },
    wrappedKey: toB64(wrappedKey),
    iv: toB64(iv),
    ct: toB64(ct),
  }
}

/**
 * 解开（**只有超管用私钥**）。
 *
 * 三类失败各自说人话：文件不对 / 私钥读不出来 / 私钥不是这一对。
 * ⚠️ 私钥**只在这里的内存里过一遍**，调用方不许把它存起来、更不许发给服务端。
 */
export async function openAdminSealed(
  doc: unknown,
  privateKeyPem: string,
): Promise<AdminSealedPayload> {
  if (!isAdminSealed(doc)) {
    throw new Error('这不是「加密的档案备份」文件（少了封存标记）')
  }
  const sub = subtleOf()
  if (!privateKeyPem.trim()) throw new Error('还没给私钥')

  let priv: CryptoKey
  try {
    priv = await sub.importKey(
      'pkcs8',
      pemToBytes(privateKeyPem),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt'],
    )
  } catch {
    throw new Error('这把私钥读不出来 —— 要的是生成时那份 PRIVATE KEY（.pem 文件里的整段文本）')
  }

  let dek: Uint8Array<ArrayBuffer>
  try {
    dek = new Uint8Array(await sub.decrypt({ name: 'RSA-OAEP' }, priv, fromB64(doc.wrappedKey)))
  } catch {
    throw new Error('这把私钥解不开这份文件 —— 不是封它时用的那一对钥匙（看信封上的 kid）')
  }

  const aad = new TextEncoder().encode(`${doc.fmt}|${doc.kid}`)
  const aes = await sub.importKey('raw', dek, { name: 'AES-GCM' }, false, ['decrypt'])
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await sub.decrypt({ name: 'AES-GCM', iv: fromB64(doc.iv), additionalData: aad }, aes, fromB64(doc.ct)),
    )
  } catch {
    throw new Error('这份文件的正文被改过（或者传坏了）—— 解出来的内容对不上')
  }
  return JSON.parse(new TextDecoder().decode(plain)) as AdminSealedPayload
}
