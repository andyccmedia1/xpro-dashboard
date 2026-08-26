import Anthropic from '@anthropic-ai/sdk'

// AI Insights for the Scenario Planner: the client sends the baseline and the
// overlaid scenario simulations for one SKU; Claude compares the routes and
// recommends which to commit to, when to place the PO, and what to watch.

export const maxDuration = 300

const SYSTEM = `You are the inventory strategist for X PRO, an e-commerce brand selling on Amazon FBA (Shopify/TikTok orders also ship from the same FBA pool via MCF). Supplier lead times are long (~80 days from China) with real variability, so PO timing is the highest-stakes decision.

You are given one SKU's simulated ROUTES: the live baseline (current blended velocity) plus what-if scenarios (pinned demand rates with the same seasonality, deals, inbounds and blackout calendar). Each route reports: projected stockout date (null = plan holds), the first new PO the simulation places (date, quantity, arrival, any blackout adjustment), minimum and ending inventory, service level, planned deals, and inbound POs.

Your job:
1. Say which route to PLAN for and why — and crucially, what observable signal decides it (e.g. "if trailing 14-day run-rate exceeds X/day by DATE, you are on the push route").
2. Give the PO decision calendar: the latest safe order date per route, what quantity, and what to pre-negotiate with the factory now.
3. Flag fragile points: thin minimum-inventory moments vs lead-time variability, deals that drain stock right before an arrival, blackout interactions.
4. Note capital trade-offs (a bigger PO parks cash; a missed PO loses peak-season sales — the asymmetry usually favors ordering).

Write for the owner: plain text, short CAPS headings, dashes for lists, no markdown tables or asterisks. Cite actual dates, quantities and route names from the data. Lead with the single decision that matters most. Under ~450 words.`

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response('ANTHROPIC_API_KEY is not configured — add it in Vercel project settings and .env.local', { status: 500 })
  }
  const body = await request.json().catch(() => null)
  if (!body?.sku || !Array.isArray(body.routes) || body.routes.length === 0) {
    return new Response('sku and routes are required', { status: 400 })
  }
  const payload = {
    today: typeof body.today === 'string' ? body.today : undefined,
    sku: body.sku,
    horizon_days: body.horizon,
    settings: body.settings ?? {},
    routes: body.routes.slice(0, 8),
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
      content: `Compare these routes for the SKU and tell me which to commit to and when to order:\n\n${JSON.stringify(payload)}`,
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
