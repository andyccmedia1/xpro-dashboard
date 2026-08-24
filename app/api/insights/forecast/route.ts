import Anthropic from '@anthropic-ai/sdk'

// AI Insights for the Forecast tab. The client sends the per-SKU forecast
// results it has already computed (the exact numbers rendered on screen —
// reorder dates, stockout dates, safety stock, ad signals, deals, inbounds)
// plus the global planning settings; this route asks Claude to review the
// reorder plan and streams the analysis back.

export const maxDuration = 300

const SYSTEM = `You are the inventory-planning analyst for X PRO, an e-commerce brand selling on Amazon (FBA), with Shopify and some TikTok orders fulfilled via Amazon MCF — every channel depletes the same FBA pool.

Key facts:
- Supplier lead times are long (typically ~80 days from China), with variability captured per SKU as lead_time_std_days.
- The forecast is a daily simulation: velocity is blended from 7/14/30/60/90-day actuals, corrected for each SKU's real selling history (history_days excludes pre-launch and suspected stockout gaps).
- reorder_by / reorder_qty is when/what the simulation says to order; stockout is the projected date inventory hits zero EVEN WITH planned reorders and inbounds — a stockout date means the plan has a real gap.
- ad_signal: "throttle" = projected stockout, stop feeding demand; "push" = cover exceeds a full lead time + order cycle, room to drive demand; "steady" = balanced.
- inbounds are purchase orders already placed (units + arrival date). promotions are planned deals (demand multiplier over a date range). Blackout windows are factory closures (no PO placement) or FBA receiving cutoffs.
- has_params=false or on_hand=0 with real velocity usually means the SKU was never configured — call those out as data hygiene, not as stockouts.
- last_forecasted is when the owner last reviewed that SKU.

Write for the owner: plain text, short CAPS section headings, dashes for lists, no markdown tables or asterisks. Cite SKUs, dates, and quantities from the data. Lead with the most urgent item. Keep under ~500 words.`

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response('ANTHROPIC_API_KEY is not configured — add it in Vercel project settings and .env.local', { status: 500 })
  }

  const body = await request.json().catch(() => null)
  if (!body || !Array.isArray(body.skus) || body.skus.length === 0) {
    return new Response('skus payload is required', { status: 400 })
  }
  // Cap payload defensively (the catalog is ~15 SKUs; 200 is far beyond it)
  const payload = {
    today: typeof body.today === 'string' ? body.today : undefined,
    settings: body.settings ?? {},
    skus: body.skus.slice(0, 200),
  }

  const MODEL = 'claude-opus-5'
  const client = new Anthropic()
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Here is the current forecast state for every SKU (as shown in the dashboard), plus global planning settings, as JSON:\n\n${JSON.stringify(payload)}\n\nReview the reorder plan:\n1. Most urgent first — which SKUs need a PO now (or are already late), with quantities.\n2. Projected stockouts the current plan does NOT solve, and what would close each gap (earlier PO, air freight, throttle ads).\n3. Sanity-check the inputs — safety stock vs demand variability, lead times, suspicious on-hand values, unconfigured SKUs, stale last-forecasted dates.\n4. Deals & blackouts — any planned promo the stock can't support, any PO landing near a factory closure or receiving cutoff.\n5. Capital efficiency — overstocked SKUs (push candidates) where cash is parked.\nFinish with a prioritized DO THIS WEEK list of 3-5 actions.`,
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
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Model': MODEL },
  })
}
