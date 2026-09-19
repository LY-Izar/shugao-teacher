/* ============================================================
   教室端发声：提示音 + 中文语音合成
   不依赖任何音频素材，也不需要装任何东西 —— 用系统 TTS。

   三种"不出声"的情况，全都收敛在 isSilenced() 一处判断：
     · 考试模式（教师手动开的）
     · 固定静音时段（周测等）
     · 教师没点过解锁（浏览器要求先有用户交互）
   ============================================================ */

let audioCtx: AudioContext | null = null

/* ---------------- 静音 ---------------- */

/** 考试模式：教师手动开的全局静音 */
let examMuted = false

export function setExamMuted(on: boolean) {
  examMuted = on
  if (on) stopSpeaking()
}

export function isExamMuted() {
  return examMuted
}

/**
 * 固定静音时段表。
 * 做成表而不是写死"周三 15:35" —— 以后加别的时段只要往这里加一行，不动逻辑。
 */
export const QUIET_SLOTS: Array<{ weekday: number; from: string; to: string; why: string }> = [
  { weekday: 3, from: '15:35', to: '18:00', why: '周三下午' },
]

const toMin = (h: string) => {
  const [a, b] = h.split(':').map(Number)
  return a * 60 + b
}

/** 当前是否落在某个静音时段里 */
export function quietNow(now = new Date()): { quiet: boolean; why?: string } {
  // weekday: 0=周日 … 6=周六，和 Date.getDay() 一致
  const wd = now.getDay()
  const m = now.getHours() * 60 + now.getMinutes()
  for (const s of QUIET_SLOTS) {
    if (s.weekday !== wd) continue
    if (m >= toMin(s.from) && m < toMin(s.to)) return { quiet: true, why: s.why }
  }
  return { quiet: false }
}

/** 一切会发声的东西都要先问这一句 */
export function isSilenced(now = new Date()): boolean {
  return examMuted || quietNow(now).quiet
}

/* ---------------- 提示音 ---------------- */

/**
 * 「叮咚」两音提示 —— 播报前先响，避免被当成背景音忽略。
 * volume 默认 0.22；下课铃用更小的值（见 softChime）。
 */
export function chime(volume = 0.22) {
  if (isSilenced()) return
  try {
    audioCtx ??= new AudioContext()
    const ctx = audioCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    const notes = [
      { f: 988, at: 0 },
      { f: 1319, at: 0.17 },
    ]
    for (const n of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = n.f
      const start = t0 + n.at
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.6)
    }
  } catch {
    /* 音频不可用就静默跳过，不影响播报流程 */
  }
}

/**
 * 下课铃：课前 5 分钟提醒。
 * 只要**一声**、而且要轻 —— 教室里老师正在讲课，太响会打断。
 */
export function softChime() {
  if (isSilenced()) return
  try {
    audioCtx ??= new AudioContext()
    const ctx = audioCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 1174.7 // D6，比「叮咚」更柔
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + 1)
  } catch {
    /* 忽略 */
  }
}

/** 浏览器需要一次用户交互才允许出声 */
export function unlockAudio() {
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    const u = new SpeechSynthesisUtterance('')
    speechSynthesis.speak(u)
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 语音 ---------------- */

let cachedVoice: SpeechSynthesisVoice | null = null

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice
  const voices = speechSynthesis.getVoices()
  if (!voices.length) return null
  cachedVoice =
    voices.find((v) => /zh[-_]CN/i.test(v.lang) && /Xiaoxiao|Yunxi|Huihui|Kangkang/i.test(v.name)) ??
    voices.find((v) => /zh[-_]CN/i.test(v.lang)) ??
    voices.find((v) => /^zh/i.test(v.lang)) ??
    null
  return cachedVoice
}

// 语音列表是异步加载的，先预热一次
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = () => {
    cachedVoice = null
    pickVoice()
  }
}

export function speak(text: string, opts?: { rate?: number; onEnd?: () => void }) {
  if (isSilenced()) {
    opts?.onEnd?.()
    return
  }
  try {
    const u = new SpeechSynthesisUtterance(text)
    const v = pickVoice()
    if (v) u.voice = v
    u.lang = 'zh-CN'
    u.rate = opts?.rate ?? 0.92
    u.pitch = 1
    u.volume = 1
    if (opts?.onEnd) u.onend = opts.onEnd
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  } catch {
    opts?.onEnd?.()
  }
}

export function stopSpeaking() {
  try {
    speechSynthesis.cancel()
  } catch {
    /* 忽略 */
  }
}
