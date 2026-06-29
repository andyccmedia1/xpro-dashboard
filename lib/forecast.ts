// ────────────────────────────────────────────────────────────────────────────
// Inventory forecasting engine — TypeScript port of the Streamlit app's
// forecast_logic.py + weighted_velocity.py. Deterministic math, runs anywhere
// (server route or client). Fed by the live sku_velocity view.
// ────────────────────────────────────────────────────────────────────────────

// ── Weighted velocity ────────────────────────────────────────────────────────
// Blend the 7/14/30/60/90-day daily velocities into a single demand number.
export type PeriodVelocities = { v7: number; v14: number; v30: number; v60: number; v90: number }
export type PeriodWeights    = { w7: number; w14: number; w30: number; w60: number; w90: number }

export const DEFAULT_WEIGHTS: PeriodWeights = { w7: 0.10, w14: 0.15, w30: 0.40, w60: 0.20, w90: 0.15 }

/** Weighted average of the period velocities. Weights are normalised to sum to 1. */
export function weightedVelocity(v: PeriodVelocities, w: PeriodWeights): number {
  const pairs: [number, number][] = [
    [v.v7, w.w7], [v.v14, w.w14], [v.v30, w.w30], [v.v60, w.w60], [v.v90, w.w90],
  ]
  const weightSum = pairs.reduce((s, [, wt]) => s + wt, 0)
  if (weightSum <= 0) return 0
  return pairs.reduce((s, [vel, wt]) => s + vel * (wt / weightSum), 0)
}

// ── Forecast simulation ──────────────────────────────────────────────────────
export type Delivery = { day: number; qty: number }

export type ForecastParams = {
  initialInventory: number
  baseVelocity: number
  startDate: Date
  days?: number                 // default 180
  deliveries?: Delivery[]       // scheduled inbound [{day, qty}]
  leadTime?: number             // days, default 80
  safetyStockDays?: number      // default 15
  useSeasonality?: boolean
  seasonalityFactors?: Record<number, number>  // month(1-12) -> multiplier
  dynamicReorder?: boolean      // default true
  reorderPolicy?: 'R_S' | 's_Q' | 'EOQ'         // default 'R_S'
  cycleCoverDays?: number       // default 35
  minDaysBetweenOrders?: number // default 30
  moq?: number                  // default 0
  casepack?: number             // default 1
  serviceLevelZ?: number        // default 1.65 (~95%)
  demandStdDev?: number | null  // σ_d, daily demand std; default null -> 20% of baseVelocity
  leadTimeStdDays?: number      // σ_L, lead-time std in days (default 0 = deterministic)
  useServiceLevelSafety?: boolean
  stockoutMode?: 'lost_sales' | 'backorders'    // default 'lost_sales'
}

export type ForecastRow = {
  date: string
  day: number
  inventory: number
  velocity: number
  delivery: number
  deliveryAmount: number
  reorderTrigger: boolean
  reorderAmount: number
  reorderArrivalDay: number
  inventoryPosition: number
  onOrder: number
  safetyStock: number
  reorderPoint: number
  lostSales: number
  backorders: number
  fillRate: number
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

/**
 * Daily inventory simulation. Faithful port of forecast_logic.run_forecast.
 */
export function runForecast(p: ForecastParams): ForecastRow[] {
  const days        = p.days ?? 180
  const leadTime    = p.leadTime ?? 80
  const safetyDays  = p.safetyStockDays ?? 15
  const cycleCover  = p.cycleCoverDays ?? 35
  const minBetween  = p.minDaysBetweenOrders ?? 30
  const moq         = p.moq ?? 0
  const casepack    = Math.max(1, p.casepack ?? 1)
  const zScore      = p.serviceLevelZ ?? 1.65
  const policy      = p.reorderPolicy ?? 'R_S'
  const dynamic     = p.dynamicReorder ?? true
  const stockoutMode = p.stockoutMode ?? 'lost_sales'
  const useSvcSafety = p.useServiceLevelSafety ?? false
  const useSeasonality = p.useSeasonality ?? false
  const seasonality  = p.seasonalityFactors ?? Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1.0]))
  const stdDev       = p.demandStdDev ?? p.baseVelocity * 0.2

  const dates = Array.from({ length: days }, (_, i) => addDays(p.startDate, i))

  const deliveryDict: Record<number, number> = {}
  for (const d of p.deliveries ?? []) {
    if (d.day < days) deliveryDict[d.day] = (deliveryDict[d.day] ?? 0) + d.qty
  }
  const pending: Record<number, number> = {}   // dynamic reorders: day -> qty

  let inventory = p.initialInventory
  let backorderQty = 0

  const dailyVelocity = (date: Date): number =>
    useSeasonality ? p.baseVelocity * (seasonality[date.getMonth() + 1] ?? 1.0) : p.baseVelocity

  const leadTimeDemand = (startDay: number, L: number): number => {
    let total = 0
    for (let k = 1; k <= L; k++) {
      const idx = startDay + k < days ? startDay + k : Math.min(startDay + k, days - 1)
      total += dailyVelocity(dates[idx])
    }
    return total
  }
  const sigmaL = p.leadTimeStdDays ?? 0
  const safetyStockDaysBased = (v: number) => v * safetyDays
  // SS = z · √(L·σ_d²  +  d²·σ_L²) — demand variability + lead-time variability
  const safetyStockServiceLevel = (L: number) =>
    zScore * Math.sqrt(stdDev * stdDev * L + p.baseVelocity * p.baseVelocity * sigmaL * sigmaL)
  const roundToCasepack = (qty: number): number => {
    if (qty <= 0) return 0
    return Math.max(Math.ceil(qty / casepack) * casepack, moq)
  }

  const rows: ForecastRow[] = []

  for (let i = 0; i < days; i++) {
    const date = dates[i]
    const todayVel = dailyVelocity(date)

    // Deliveries arriving today (scheduled + dynamic)
    let deliveryToday = (deliveryDict[i] ?? 0) + (pending[i] ?? 0)

    if (stockoutMode === 'backorders') {
      if (deliveryToday > 0 && backorderQty > 0) {
        const fill = Math.min(deliveryToday, backorderQty)
        backorderQty -= fill
        deliveryToday -= fill
      }
      inventory += deliveryToday
    } else {
      inventory = Math.max(0, inventory)
      inventory += deliveryToday
    }

    // Dynamic reorder
    if (dynamic) {
      const ltDemand = leadTimeDemand(i, leadTime)
      const safetyStock = useSvcSafety ? safetyStockServiceLevel(leadTime) : safetyStockDaysBased(todayVel)
      const reorderPoint = ltDemand + safetyStock

      let onOrder = 0
      for (let f = i + 1; f < days; f++) onOrder += (deliveryDict[f] ?? 0) + (pending[f] ?? 0)
      let invPosition = stockoutMode === 'backorders' ? inventory + onOrder - backorderQty : inventory + onOrder

      let recentReorder = false
      for (let c = Math.max(0, i - minBetween); c < i; c++) {
        if (rows[c]?.reorderTrigger) { recentReorder = true; break }
      }

      const reorderNeeded = invPosition <= reorderPoint && !recentReorder && i + leadTime < days
      if (reorderNeeded) {
        let orderQty: number
        if (policy === 'R_S') {
          const cycleDemand = todayVel * cycleCover
          orderQty = ltDemand + safetyStock + cycleDemand - invPosition
        } else if (policy === 's_Q') {
          orderQty = Math.max(ltDemand, moq)
        } else if (policy === 'EOQ') {
          const annualDemand = todayVel * 365
          orderQty = Math.max(Math.sqrt((2 * annualDemand * 100) / 0.25), ltDemand)
        } else {
          orderQty = ltDemand + safetyStock - invPosition
        }
        orderQty = roundToCasepack(orderQty)
        if (orderQty > 0) {
          const arrival = i + leadTime
          if (arrival < days) {
            pending[arrival] = (pending[arrival] ?? 0) + orderQty
            invPosition += orderQty
            // mark on the (soon-to-be-pushed) row
            rows[i] = { ...(rows[i] ?? {} as ForecastRow), reorderTrigger: true, reorderAmount: orderQty, reorderArrivalDay: arrival } as ForecastRow
          }
        }
      }
    }

    // Demand consumption
    const demand = todayVel
    let lostSales = 0
    if (stockoutMode === 'backorders') {
      if (inventory >= demand) inventory -= demand
      else { backorderQty += demand - inventory; inventory = 0 }
    } else {
      if (inventory >= demand) inventory -= demand
      else { lostSales = demand - inventory; inventory = 0 }
    }
    const fillRate = demand > 0 ? (demand - lostSales) / demand : 1.0

    let onOrderToday = 0
    for (let f = i + 1; f < days; f++) onOrderToday += (deliveryDict[f] ?? 0) + (pending[f] ?? 0)

    const curSafety = useSvcSafety ? safetyStockServiceLevel(leadTime) : safetyStockDaysBased(todayVel)
    const curReorderPoint = leadTimeDemand(i, leadTime) + curSafety

    const prior = rows[i]   // may hold a reorder marker set above
    rows[i] = {
      date: date.toISOString().slice(0, 10),
      day: i,
      inventory,
      velocity: todayVel,
      delivery: deliveryToday > 0 ? 1 : 0,
      deliveryAmount: deliveryToday,
      reorderTrigger: prior?.reorderTrigger ?? false,
      reorderAmount: prior?.reorderAmount ?? 0,
      reorderArrivalDay: prior?.reorderArrivalDay ?? 0,
      inventoryPosition: inventory + onOrderToday - (stockoutMode === 'backorders' ? backorderQty : 0),
      onOrder: onOrderToday,
      safetyStock: curSafety,
      reorderPoint: curReorderPoint,
      lostSales,
      backorders: stockoutMode === 'backorders' ? backorderQty : 0,
      fillRate,
    }
  }

  return rows
}

// ── Analytics ────────────────────────────────────────────────────────────────
export type ForecastAnalytics = {
  stockoutCount: number
  firstStockoutDay: number | null
  firstStockoutDate: string | null
  reorderCount: number
  firstReorderDay: number | null
  firstReorderDate: string | null
  firstReorderQty: number
  totalReordered: number
  avgInventory: number
  minInventory: number
  serviceLevel: number
  daysOfSupply: number
}

export function analyzeForecast(rows: ForecastRow[]): ForecastAnalytics {
  const stockoutRows = rows.filter(r => r.inventory <= 0)
  const reorderRows  = rows.filter(r => r.reorderTrigger)
  const totalDemand  = rows.reduce((s, r) => s + r.velocity, 0)
  const totalLost    = rows.reduce((s, r) => s + r.lostSales, 0)
  const avgInv       = rows.reduce((s, r) => s + r.inventory, 0) / (rows.length || 1)
  const firstReorder = reorderRows[0] ?? null

  return {
    stockoutCount: stockoutRows.length,
    firstStockoutDay:  stockoutRows[0]?.day ?? null,
    firstStockoutDate: stockoutRows[0]?.date ?? null,
    reorderCount: reorderRows.length,
    firstReorderDay:  firstReorder?.day ?? null,
    firstReorderDate: firstReorder?.date ?? null,
    firstReorderQty:  firstReorder?.reorderAmount ?? 0,
    totalReordered: reorderRows.reduce((s, r) => s + r.reorderAmount, 0),
    avgInventory: Math.round(avgInv),
    minInventory: rows.reduce((m, r) => Math.min(m, r.inventory), Infinity),
    serviceLevel: totalDemand > 0 ? (totalDemand - totalLost) / totalDemand : 1.0,
    daysOfSupply: totalDemand > 0 ? avgInv / (totalDemand / rows.length) : 0,
  }
}
