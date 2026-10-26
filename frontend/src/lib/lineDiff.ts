/**
 * Лёгкий построчный diff (алгоритм Майерса) без внешних зависимостей.
 * Общие префикс и суффикс отрезаются заранее — для типичной правки конфига Майерс работает
 * только на небольшом изменённом участке.
 */

export type DiffLine =
  | { type: 'equal'; text: string; oldNo: number; newNo: number }
  | { type: 'del'; text: string; oldNo: number }
  | { type: 'add'; text: string; newNo: number }

export type DiffRow = DiffLine | { type: 'fold'; id: number; lines: DiffLine[] }

export interface DiffResult {
  lines: DiffLine[]
  added: number
  removed: number
}

/** Если расстояние редактирования больше — считаем изменённый участок заменённым целиком. */
const MAX_EDIT_DISTANCE = 4000

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Op = 'e' | 'd' | 'a'

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []

  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m, d)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number, depth: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = depth; d > 0; d--) {
    const prev = trace[d]
    const at = (k: number) => prev[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('e')
      x--
      y--
    }
    ops.push(x === prevX ? 'a' : 'd')
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    ops.push('e')
    x--
    y--
  }
  return ops.reverse()
}

export function diffLines(before: string, after: string): DiffResult {
  const a = splitLines(before)
  const b = splitLines(after)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const ops: Op[] = myers(midA, midB) ?? [...midA.map((): Op => 'd'), ...midB.map((): Op => 'a')]

  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  for (let i = 0; i < start; i++) lines.push({ type: 'equal', text: a[i], oldNo: i + 1, newNo: i + 1 })

  let i = start
  let j = start
  for (const op of ops) {
    if (op === 'e') {
      lines.push({ type: 'equal', text: a[i], oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (op === 'd') {
      lines.push({ type: 'del', text: a[i], oldNo: i + 1 })
      removed++
      i++
    } else {
      lines.push({ type: 'add', text: b[j], newNo: j + 1 })
      added++
      j++
    }
  }

  for (; i < a.length; i++, j++) lines.push({ type: 'equal', text: a[i], oldNo: i + 1, newNo: j + 1 })

  return { lines, added, removed }
}

/** Сворачивает длинные участки без изменений, оставляя `context` строк вокруг каждой правки. */
export function foldUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Uint8Array(lines.length)
  lines.forEach((line, idx) => {
    if (line.type === 'equal') return
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = 1
  })

  const rows: DiffRow[] = []
  let buffer: DiffLine[] = []
  let foldId = 0
  const flush = () => {
    if (!buffer.length) return
    // Сворачивать одну-две строки бессмысленно — плашка займёт столько же места
    if (buffer.length <= 2) rows.push(...buffer)
    else rows.push({ type: 'fold', id: foldId++, lines: buffer })
    buffer = []
  }

  lines.forEach((line, idx) => {
    if (keep[idx]) {
      flush()
      rows.push(line)
    } else buffer.push(line)
  })
  flush()
  return rows
}
