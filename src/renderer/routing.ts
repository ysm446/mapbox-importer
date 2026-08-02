// 取り込んだルート（独立した折れ線の集まり）をグラフへ組み直し、2点間の最短経路を求める。
// Three.js・DOM には依存しない純粋な計算だけを置く（shared/mercator.ts と同じ方針）。
//
// トポロジーの復元について：
// OSM の way は交差点で同じノードを共有するため、Overpass の `out geom` が返す座標は
// 交差点でそのまま一致する。よって頂点を座標でまとめる（weld する）だけで道路網の
// 繋がりが再現できる。立体交差（橋・トンネル）は交差点ノードを持たず座標も一致しないので、
// 自動的に「繋がらない」という正しい結果になる。

import type { Route, RouteCategory } from '../preload/index'

const EARTH_R = 6371000

/**
 * ノードをまとめるときの量子化精度（度）。約1cm。
 * osm.ts のクリップ処理は線分の端点を `a + t*(b-a)` で作るため、t=1 の端点が元の座標と
 * 浮動小数で 1ulp ずれ得る。完全一致で照合すると交差点が繋がらないので量子化して束ねる。
 */
const NODE_QUANT = 1e-7

/** 経路探索の既定対象。鉄道・ロープウェイは徒歩/車の経路にならないので既定から外す。 */
export const DEFAULT_ROUTING_CATEGORIES: RouteCategory[] = ['road', 'foot', 'trail']

/** 2点間の水平距離(m)。1ロケーションの bbox は狭いので等距円筒近似で十分。 */
export function horizontalMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const toRad = Math.PI / 180
  const midLat = ((lat1 + lat2) / 2) * toRad
  const dx = (lng2 - lng1) * toRad * Math.cos(midLat)
  const dy = (lat2 - lat1) * toRad
  return Math.hypot(dx, dy) * EARTH_R
}

/** ルート網を無向グラフにしたもの。隣接は CSR（offsets/targets/weights）で持つ。 */
export interface RouteGraph {
  nodeCount: number
  lng: Float64Array
  lat: Float64Array
  /** node i の辺は targets[offsets[i]] … targets[offsets[i + 1] - 1] */
  offsets: Int32Array
  targets: Int32Array
  /** 辺の重み（水平距離[m]）。コスト定義を変えるならここを差し替える。 */
  weights: Float64Array
  /** スナップ用の全線分（両端のノード index）。segA.length が線分数。 */
  segA: Int32Array
  segB: Int32Array
}

/**
 * ルート群からグラフを組み立てる。cats に含まれる種別・表示中のルートだけを対象にする
 * （3D で見えている線がそのまま経路探索の対象になる）。
 */
export function buildRouteGraph(routes: Route[], cats: RouteCategory[]): RouteGraph {
  const catSet = new Set(cats)
  const index = new Map<string, number>()
  const lngs: number[] = []
  const lats: number[] = []
  const edgeFrom: number[] = []
  const edgeTo: number[] = []
  const edgeW: number[] = []
  const segA: number[] = []
  const segB: number[] = []

  const nodeOf = (lng: number, lat: number): number => {
    const key = `${Math.round(lng / NODE_QUANT)},${Math.round(lat / NODE_QUANT)}`
    let i = index.get(key)
    if (i === undefined) {
      i = lngs.length
      index.set(key, i)
      lngs.push(lng)
      lats.push(lat)
    }
    return i
  }

  for (const r of routes) {
    if (r.visible === false || !catSet.has(r.category) || r.coords.length < 2) continue
    let prev = nodeOf(r.coords[0][0], r.coords[0][1])
    for (let i = 1; i < r.coords.length; i++) {
      const cur = nodeOf(r.coords[i][0], r.coords[i][1])
      if (cur === prev) continue // 量子化で同じ点に潰れた重複頂点
      const w = horizontalMeters(lngs[prev], lats[prev], lngs[cur], lats[cur])
      edgeFrom.push(prev, cur)
      edgeTo.push(cur, prev)
      edgeW.push(w, w)
      segA.push(prev)
      segB.push(cur)
      prev = cur
    }
  }

  // 隣接リストを CSR へ詰め直す
  const nodeCount = lngs.length
  const offsets = new Int32Array(nodeCount + 1)
  for (const f of edgeFrom) offsets[f + 1]++
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] += offsets[i]
  const cursor = offsets.slice(0, nodeCount)
  const targets = new Int32Array(edgeTo.length)
  const weights = new Float64Array(edgeW.length)
  for (let e = 0; e < edgeFrom.length; e++) {
    const p = cursor[edgeFrom[e]]++
    targets[p] = edgeTo[e]
    weights[p] = edgeW[e]
  }

  return {
    nodeCount,
    lng: Float64Array.from(lngs),
    lat: Float64Array.from(lats),
    offsets,
    targets,
    weights,
    segA: Int32Array.from(segA),
    segB: Int32Array.from(segB)
  }
}

/** 指定した点を最寄りの線分へ落とした結果（経路の起点/終点になる仮ノード）。 */
export interface SnapResult {
  segIndex: number
  /** 線分上の位置 0..1（segA→segB 方向） */
  t: number
  lng: number
  lat: number
  /** 元の点からスナップ先までの距離(m) */
  distMeters: number
}

/** 線分 segIndex の水平長(m) */
function segmentLength(g: RouteGraph, segIndex: number): number {
  const a = g.segA[segIndex]
  const b = g.segB[segIndex]
  return horizontalMeters(g.lng[a], g.lat[a], g.lng[b], g.lat[b])
}

/**
 * 点 (lng,lat) から一番近いルート上の点（線分への垂線の足）を求める。
 * 比較は緯度補正した平面上の二乗距離で行い、最後にメートルへ直す。
 */
export function snapToGraph(g: RouteGraph, lng: number, lat: number): SnapResult | null {
  const segCount = g.segA.length
  if (segCount === 0) return null
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const px = lng * cosLat
  const py = lat

  let bestSeg = -1
  let bestT = 0
  let bestD2 = Infinity
  for (let s = 0; s < segCount; s++) {
    const a = g.segA[s]
    const b = g.segB[s]
    const ax = g.lng[a] * cosLat
    const ay = g.lat[a]
    const dx = g.lng[b] * cosLat - ax
    const dy = g.lat[b] - ay
    const len2 = dx * dx + dy * dy
    let t = 0
    if (len2 > 0) {
      t = ((px - ax) * dx + (py - ay) * dy) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
    }
    const cx = ax + t * dx - px
    const cy = ay + t * dy - py
    const d2 = cx * cx + cy * cy
    if (d2 < bestD2) {
      bestD2 = d2
      bestSeg = s
      bestT = t
    }
  }
  if (bestSeg < 0) return null

  const a = g.segA[bestSeg]
  const b = g.segB[bestSeg]
  const slng = g.lng[a] + bestT * (g.lng[b] - g.lng[a])
  const slat = g.lat[a] + bestT * (g.lat[b] - g.lat[a])
  return {
    segIndex: bestSeg,
    t: bestT,
    lng: slng,
    lat: slat,
    distMeters: horizontalMeters(lng, lat, slng, slat)
  }
}

/** ダイクストラ用の最小ヒープ（キー=距離, 値=ノード index）。 */
class MinHeap {
  private keys: number[] = []
  private vals: number[] = []

  get size(): number {
    return this.keys.length
  }

  push(key: number, val: number): void {
    this.keys.push(key)
    this.vals.push(val)
    let i = this.keys.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] <= this.keys[i]) break
      this.swap(p, i)
      i = p
    }
  }

  /** 最小キーの値（ノード index）を取り出す。空なら -1。 */
  pop(): number {
    if (this.keys.length === 0) return -1
    const top = this.vals[0]
    const k = this.keys.pop() as number
    const v = this.vals.pop() as number
    if (this.keys.length > 0) {
      this.keys[0] = k
      this.vals[0] = v
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r
        if (m === i) break
        this.swap(m, i)
        i = m
      }
    }
    return top
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a]
    this.keys[a] = this.keys[b]
    this.keys[b] = k
    const v = this.vals[a]
    this.vals[a] = this.vals[b]
    this.vals[b] = v
  }
}

/**
 * スナップ済みの起点→終点を結ぶ最短経路（水平距離基準）の折れ線を返す。
 * 経路が無い（起終点が別々の連結成分にある）場合は null。
 *
 * 起終点は線分の途中に乗るので、線分の両端ノードを始点集合／終点集合として扱い、
 * 端までの距離を初期コスト／末尾コストに足したうえでダイクストラ法で解く。
 */
export function findPath(g: RouteGraph, start: SnapResult, goal: SnapResult): [number, number][] | null {
  // 同じ線分上なら、その線分を直進するのが最短（回り道が短くなることはない）。
  if (start.segIndex === goal.segIndex) {
    return dedupe([
      [start.lng, start.lat],
      [goal.lng, goal.lat]
    ])
  }

  const n = g.nodeCount
  if (n === 0) return null
  const dist = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  const heap = new MinHeap()

  const startLen = segmentLength(g, start.segIndex)
  const sa = g.segA[start.segIndex]
  const sb = g.segB[start.segIndex]
  const addSource = (node: number, d: number) => {
    if (d < dist[node]) {
      dist[node] = d
      heap.push(d, node)
    }
  }
  addSource(sa, start.t * startLen)
  addSource(sb, (1 - start.t) * startLen)

  const goalLen = segmentLength(g, goal.segIndex)
  const ga = g.segA[goal.segIndex]
  const gb = g.segB[goal.segIndex]
  const tailA = goal.t * goalLen
  const tailB = (1 - goal.t) * goalLen

  while (heap.size > 0) {
    const u = heap.pop()
    if (done[u]) continue
    done[u] = 1
    if (done[ga] && done[gb]) break // 終点側の両端が確定したら打ち切り
    const du = dist[u]
    for (let e = g.offsets[u]; e < g.offsets[u + 1]; e++) {
      const v = g.targets[e]
      if (done[v]) continue
      const nd = du + g.weights[e]
      if (nd < dist[v]) {
        dist[v] = nd
        prev[v] = u
        heap.push(nd, v)
      }
    }
  }

  const costA = dist[ga] + tailA
  const costB = dist[gb] + tailB
  const end = costA <= costB ? ga : gb
  if (!isFinite(Math.min(costA, costB))) return null // 経路なし（連結成分が別）

  const nodes: number[] = []
  for (let cur = end; cur !== -1; cur = prev[cur]) nodes.push(cur)
  nodes.reverse()

  const coords: [number, number][] = [[start.lng, start.lat]]
  for (const i of nodes) coords.push([g.lng[i], g.lat[i]])
  coords.push([goal.lng, goal.lat])
  return dedupe(coords)
}

/** 連続する同一点（量子化精度で同じ点）を取り除く */
function dedupe(coords: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const c of coords) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - c[0]) < NODE_QUANT && Math.abs(last[1] - c[1]) < NODE_QUANT) continue
    out.push(c)
  }
  return out
}

/** 経路の距離・登降・勾配。 */
export interface PathMetrics {
  /** 水平距離の合計(m) */
  horizontalMeters: number
  /** 標高差を含む実距離（斜距離）の合計(m) */
  surfaceMeters: number
  /** 累積の上り(m) */
  ascentMeters: number
  /** 累積の下り(m) */
  descentMeters: number
  /** 平均勾配(%)＝Σ|標高差| ÷ Σ水平距離（3Dのルートラベルと同じ定義） */
  averageGradePercent: number
}

/** 経路の折れ線と各頂点の標高(m)から距離・勾配を集計する。 */
export function computePathMetrics(coords: [number, number][], elevations: number[]): PathMetrics {
  let horizontal = 0
  let surface = 0
  let ascent = 0
  let descent = 0
  let absVert = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const h = horizontalMeters(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
    const dz = (elevations[i + 1] ?? 0) - (elevations[i] ?? 0)
    horizontal += h
    surface += Math.hypot(h, dz)
    if (dz > 0) ascent += dz
    else descent -= dz
    absVert += Math.abs(dz)
  }
  return {
    horizontalMeters: horizontal,
    surfaceMeters: surface,
    ascentMeters: ascent,
    descentMeters: descent,
    averageGradePercent: horizontal > 0 ? (absVert / horizontal) * 100 : 0
  }
}
