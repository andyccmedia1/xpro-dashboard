import { createAdminClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

// AI Insights — sends the date range's business data to Claude and streams the
// analysis back as plain text. Called from the Overview tab's ✦ AI Insights
// button. The API key lives in ANTHROPIC_API_KEY (Vercel env / .env.local),
// server-side only.

export const maxDuration = 300   // Claude Opus with thinking can take a couple of minutes

const num = (v: unknown) => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}

// Business context Claude needs to read the numbers correctly. Kept stable so
// the prompt prefix caches across clicks.
const SYSTEM = `You are the in-house analyst for X PRO, an e-commerce brand selling on Amazon (FBA), Shopify, and TikTok Shop.

How the business works:
- Amazon is the primary channel (~90% of revenue). Amazon PPC (Sponsored Products/Brands/Display) drives it.
- Shopify and some TikTok Shop orders are fulfilled via Amazon MCF, so ALL channels deplete the same FBA inventory pool.
- Meta ads drive the Shopify store (Meta ROAS = Shopify revenue ÷ Meta spend). TikTok ads drive TikTok Shop.
- Supplier lead times are long (~80 days, from China), so inventory risk is a first-class concern.

Known data caveats (do not treat these as business anomalies):
- Amazon PPC spend under $10/day is a broken partial from the Ads API (real spend runs $600-1000/day). Ignore those days in spend/ROAS analysis and do not average them in.
- The most recent 1-2 days of PPC spend may still be null (Amazon finalises late).
- Meta and TikTok ad spend come from manual CSV uploads and may be missing for recent days. If total spend equals Amazon PPC exactly, the other platforms' data is missing, not zero.

Write for the owner: plain text, short section headings in CAPS, dashes for lists, no markdown tables, no asterisks. Be direct and specific — cite actual numbers and dates from the data. Lead with the single most important finding. Keep it under ~500 words.`

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response('ANTHROPIC_API_KEY is not configured — add it in Vercel project settings and .env.local', { status: 500 })
  }

  const body = await request.json().catch(() => ({}))
  const brand = body.brand ?? 'xpro'
  const start = typeof body.start === 'string' ? body.start : ''
  const end   = typeof body.end === 'string' ? body.end : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return new Response('start and end (YYYY-MM-DD) are required', { status: 400 })
  }

  const supabase = createAdminClient()

  // ── Gather the data Claude will analyse ────────────────────────────────────
  const [{ data: daily }, { data: campaigns }, { data: vel }, { data: params }] = await Promise.all([
    supabase.from('daily_data')
      .select('date, amazon_revenue, amazon_ppc_spend, shopify_revenue, tiktok_shop_revenue, tiktok_ads_spend, meta_ads_spend')
      .eq('brand', brand).gte('date', start).lte('date', end).order('date'),
    supabase.from('campaign_daily')
      .select('campaign_name, ad_product, cost, sales, orders, clicks')
      .eq('brand', brand).gte('date', start).lte('date', end),
    supabase.from('sku_velocity').select('msku, vel_30').eq('brand', brand),
    supabase.from('sku_params').select('msku, on_hand, lead_time_days').eq('brand', brand),
  ])

  // Campaign aggregates (top 12 by spend)
  const byCampaign = new Map<string, { name: string; type: string; cost: number; sales: number; orders: number; clicks: number }>()
  for (const r of (campaigns ?? []) as Record<string, unknown>[]) {
    const key = String(r.campaign_name ?? 'unknown')
    const c = byCampaign.get(key) ?? { name: key, type: String(r.ad_product ?? ''), cost: 0, sales: 0, orders: 0, clicks: 0 }
    c.cost += num(r.cost); c.sales += num(r.sales); c.orders += num(r.orders); c.clicks += num(r.clicks)
    byCampaign.set(key, c)
  }
  const topCampaigns = [...byCampaign.values()].sort((a, b) => b.cost - a.cost).slice(0, 12)
    .map(c => ({ ...c, cost: Math.round(c.cost), sales: Math.round(c.sales), roas: c.cost > 0 ? Math.round((c.sales / c.cost) * 100) / 100 : null }))

  // Inventory risk: days of cover per SKU at 30-day velocity
  const onHand = new Map<string, { on_hand: number; lead: number }>(
    (params ?? []).map((p: Record<string, unknown>) => [p.msku as string, { on_hand: num(p.on_hand), lead: num(p.lead_time_days) }]),
  )
  const inventory = ((vel ?? []) as Record<string, unknown>[])
    .map(r => {
      const p = onHand.get(r.msku as string)
      const v30 = num(r.vel_30)
      return {
        sku: r.msku as string,
        vel_30: v30,
        on_hand: p?.on_hand ?? 0,
        lead_time_days: p?.lead ?? 80,
        days_cover: p && v30 > 0 ? Math.round(p.on_hand / v30) : null,
      }
    })
    .filter(r => r.vel_30 > 0.5)
    .sort((a, b) => (a.days_cover ?? 9999) - (b.days_cover ?? 9999))

  const payload = {
    period: { start, end },
    daily: (daily ?? []).map((r: Record<string, unknown>) => ({
      date: r.date,
      amz_rev: num(r.amazon_revenue), ppc: r.amazon_ppc_spend == null ? null : num(r.amazon_ppc_spend),
      shopify_rev: num(r.shopify_revenue), tiktok_rev: num(r.tiktok_shop_revenue),
      tiktok_ads: r.tiktok_ads_spend == null ? null : num(r.tiktok_ads_spend),
      meta_ads: r.meta_ads_spend == null ? null : num(r.meta_ads_spend),
    })),
    top_campaigns: topCampaigns,
    inventory_days_of_cover: inventory,
  }

  // ── Ask Claude, streaming the answer straight through to the browser ───────
  const client = new Anthropic()
  const stream = client.messages.stream({
    model: 'claude-opus-5',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Here is the business data for ${start} → ${end} as JSON:\n\n${JSON.stringify(payload)}\n\nAnalyse the period: the most important finding first, then revenue & trend, ad efficiency (overall and which campaigns look over/under-funded), channel mix, inventory risks given the lead times, and finish with a short DO THIS WEEK list of 3-5 concrete actions.`,
    }],
  })

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(event.delta.text))
          }
        }
      } catch (e) {
        controller.enqueue(encoder.encode(`\n\n[Analysis interrupted: ${e instanceof Error ? e.message : 'unknown error'}]`))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
