// Multinomial logistic regression (softmax) with L2, in plain TypeScript: features standardised
// (mean / std kept with the model), full-batch gradient descent (deterministic: same data, same
// model), and Platt scaling for binary models so a predicted 0.8 means "right about 80% of the time".
// Small by design: a few dozen features, a few hundred examples, trained in milliseconds in-process.

export interface Standardizer {
  mean: number[]
  std: number[]
}

export interface SoftmaxModel {
  // k x d weights and k biases over standardised features.
  W: number[][]
  b: number[]
}

export interface TrainOptions {
  l2?: number
  iterations?: number
  rate?: number
}

export function fitStandardizer(X: number[][]): Standardizer {
  const d = X[0]?.length ?? 0
  const mean = new Array(d).fill(0)
  const std = new Array(d).fill(0)
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / X.length
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / X.length
  return { mean, std: std.map((v) => (v > 1e-12 ? Math.sqrt(v) : 1)) }
}

export function standardize(s: Standardizer, x: number[]): number[] {
  return x.map((v, j) => (Number.isFinite(v) ? (v - s.mean[j]) / s.std[j] : 0))
}

export function softmax(z: number[]): number[] {
  const m = Math.max(...z)
  const e = z.map((v) => Math.exp(v - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / s)
}

export function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z))
}

export function scores(m: SoftmaxModel, x: number[]): number[] {
  return m.W.map((w, c) => w.reduce((s, wj, j) => s + wj * x[j], m.b[c]))
}

export function predictProba(m: SoftmaxModel, x: number[]): number[] {
  return softmax(scores(m, x))
}

// X already standardised; y class indices 0..k-1. Minimises mean cross-entropy + l2/2 * |W|^2.
export function fitSoftmax(X: number[][], y: number[], k: number, opts: TrainOptions = {}): SoftmaxModel {
  const d = X[0]?.length ?? 0
  const l2 = opts.l2 ?? 0.01
  const iters = opts.iterations ?? 500
  const rate = opts.rate ?? 0.5
  const W = Array.from({ length: k }, () => new Array(d).fill(0))
  const b = new Array(k).fill(0)
  // Start the biases at the class log-frequencies (faster, and right for an all-noise feature set).
  const counts = new Array(k).fill(1)
  for (const c of y) counts[c]++
  const total = counts.reduce((a, c) => a + c, 0)
  for (let c = 0; c < k; c++) b[c] = Math.log(counts[c] / total)
  const n = X.length
  if (!n) return { W, b }
  for (let it = 0; it < iters; it++) {
    const gW = Array.from({ length: k }, () => new Array(d).fill(0))
    const gb = new Array(k).fill(0)
    for (let i = 0; i < n; i++) {
      const p = softmax(scores({ W, b }, X[i]))
      for (let c = 0; c < k; c++) {
        const err = (p[c] - (y[i] === c ? 1 : 0)) / n
        gb[c] += err
        const row = gW[c]
        const x = X[i]
        for (let j = 0; j < d; j++) row[j] += err * x[j]
      }
    }
    for (let c = 0; c < k; c++) {
      b[c] -= rate * gb[c]
      for (let j = 0; j < d; j++) W[c][j] -= rate * (gW[c][j] + l2 * W[c][j])
    }
  }
  return { W, b }
}

export interface Platt {
  a: number
  b: number
}

const logit = (p: number) => Math.log(Math.max(1e-6, Math.min(1 - 1e-6, p)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, p))))

// Platt scaling: p' = sigmoid(a * logit(p) + b), fitted by gradient descent on (p, label) pairs with
// Platt's smoothed targets ((n+ + 1) / (n+ + 2), 1 / (n- + 2)) so a small set does not over-sharpen.
export function fitPlatt(ps: number[], labels: number[], iterations = 300): Platt {
  const pos = labels.filter((l) => l === 1).length
  const neg = labels.length - pos
  const hi = (pos + 1) / (pos + 2)
  const lo = 1 / (neg + 2)
  let a = 1
  let b = 0
  const n = ps.length
  if (!n) return { a, b }
  for (let it = 0; it < iterations; it++) {
    let ga = 0
    let gb = 0
    for (let i = 0; i < n; i++) {
      const z = logit(ps[i])
      const err = sigmoid(a * z + b) - (labels[i] === 1 ? hi : lo)
      ga += (err * z) / n
      gb += err / n
    }
    a -= 0.5 * ga
    b -= 0.5 * gb
  }
  return { a, b }
}

export function applyPlatt(p: number, platt: Platt | undefined): number {
  return platt ? sigmoid(platt.a * logit(p) + platt.b) : p
}

// Expected calibration error over `bins` equal-width bins (lower is better).
export function calibrationError(ps: number[], labels: number[], bins = 10): number {
  let err = 0
  for (let k = 0; k < bins; k++) {
    const idx = ps.map((p, i) => [p, i] as const).filter(([p]) => (k === bins - 1 ? p >= k / bins : p >= k / bins && p < (k + 1) / bins))
    if (!idx.length) continue
    const conf = idx.reduce((s, [p]) => s + p, 0) / idx.length
    const acc = idx.reduce((s, [, i]) => s + labels[i], 0) / idx.length
    err += (idx.length / ps.length) * Math.abs(conf - acc)
  }
  return err
}
