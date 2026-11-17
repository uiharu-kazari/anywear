// Prompts + output validation shared by the server (Gemini, structured output)
// and the Anna edition (anna.llm.complete, JSON-by-instruction). Keeping one
// copy means both surfaces judge looks the same way.

export interface DetectedGarment {
  label: string;
  category: 'upper_body' | 'lower_body' | 'full_body';
  box_2d: [number, number, number, number]; // ymin, xmin, ymax, xmax in 0-1000
  description: string;
  confidence: number;
}

export interface SkinBrief {
  headline: string;
  summary: string;
  care_focus: { title: string; why: string; action: string }[];
  palette: {
    guidance: string;
    wear: { hex: string; name: string; why: string }[];
    avoid: { hex: string; name: string; why: string }[];
  };
}

export interface StylistVerdict {
  verdict: 'wear_it' | 'maybe' | 'skip';
  score: number;
  headline: string;
  reasons: string[];
  skin_harmony: string;
  pairing: string[];
}

export type SkinConcern = { type: string; raw_score: number; ui_score: number };

// --- Prompts ---------------------------------------------------------------

export const GARMENT_PROMPT = `Detect every distinct wearable clothing item in this image that could be virtually tried on.
The image may be a messy phone screenshot: e-commerce product pages, social media posts, street style photos — possibly containing UI chrome, text, prices, buttons, multiple products.

For each garment return:
- label: short shopper-friendly name (e.g. "Linen blazer", "Pleated midi skirt")
- category: "upper_body" (tops, shirts, jackets), "lower_body" (pants, skirts, shorts) or "full_body" (dresses, jumpsuits, full outfits/co-ords)
- box_2d: TIGHT bounding box [ymin, xmin, ymax, xmax] scaled 0-1000, covering the garment itself and cropping away surrounding UI, text and unrelated background as much as possible. If the garment is worn by a model, include the worn garment region.
- description: one sentence: color, fabric/texture, silhouette, styling notes
- confidence: 0-1 that this is a clearly try-on-able garment

Rules: skip shoes, bags, hats, jewelry, accessories. Skip garments that are mostly occluded or under ~15% of the image. If one model wears a complete matching outfit, you may return it as one full_body item in addition to its parts. Order by confidence descending, max 6 items.`;

export function skinBriefPrompt(concerns: SkinConcern[]): string {
  return `You are a stylist-facing skin interpreter inside a fashion app. Input: today's AI skin analysis of the user (scores 0-100, HIGHER = BETTER condition for that concern).

${JSON.stringify(concerns, null, 2)}

The app shows these concerns to the user under display names: oiliness = "Oil balance", acne = "Clarity" (redness, moisture, radiance, texture keep their names). Always refer to concerns by their display name, never by the internal key (say "oil balance", not "oiliness"; "clarity", not "acne"), including in care_focus titles.

Produce today's "skin brief":
- headline: 4-8 word friendly headline about today's skin state (no alarmism)
- summary: 2 sentences interpreting the standout scores (mention the 2 best and 2 most-in-need areas by name, plain language)
- care_focus: the 2-3 lowest-scoring concerns as {title, why (1 sentence, tie to the score), action (1 concrete same-day skincare/lifestyle action)}
- palette: clothing color guidance for TODAY based on skin state (e.g. visible redness → avoid saturated reds near the face that amplify it, favor cool sages/blues; dullness/low radiance → luminous warm tones lift; dark circles → avoid draining muddy tones near face). guidance: 1-2 sentences of overall logic. wear: 4 colors {hex, name, why}. avoid: 2 colors {hex, name, why}. Hex values must be realistic, slightly muted fabric/dye colors you would actually find on clothing (e.g. sage #8A9A7B, dusty blue #7D93A8, camel #B08A5E) — never pure screen colors like #FFD700, #90EE90 or #FF0000.

Never give medical claims or product brand names. Tone: warm, specific, zero fluff.`;
}

export function verdictPrompt(opts: {
  garment: { label: string; description: string };
  occasion: string;
  brief?: SkinBrief | null;
}): string {
  const briefText = opts.brief
    ? `Today's skin brief for this user:\n${JSON.stringify({ headline: opts.brief.headline, summary: opts.brief.summary, palette: opts.brief.palette }, null, 2)}`
    : 'No skin analysis available — judge on fit, color harmony with visible complexion, and occasion only.';
  return `You are an honest personal stylist. This image is an AI-generated virtual try-on of YOUR CLIENT actually wearing: ${opts.garment.label} — ${opts.garment.description}.
Occasion they are dressing for: "${opts.occasion}".
${briefText}

Judge THIS look on THIS person:
- verdict: "wear_it" | "maybe" | "skip"
- score: 0-100 overall
- headline: one punchy sentence a friend would text back
- reasons: 2-4 short concrete observations grounded in what you SEE (silhouette on their frame, color against their complexion, occasion fit). Be honest — a "skip" with a good reason builds trust.
- skin_harmony: 1 sentence on how the garment color interacts with today's skin palette guidance (or visible complexion if no brief)
- pairing: 2-3 quick suggestions to complete the look (shoes/layer/accessory categories, no brands)

Never mention that the image is AI-generated. Never comment on body size or weight — only silhouette and cut.`;
}

// Anna edition: a vision model reads the selfie directly (no dedicated skin
// engine), producing the same concern/score shape the UI already renders.
export const SKIN_CONCERNS = ['redness', 'oiliness', 'moisture', 'radiance', 'acne', 'texture'] as const;

export const SKIN_READ_PROMPT = `You are a careful beauty-and-styling assistant. This is a bare-faced selfie the user took to tune today's outfit colors.
Look only at the visible facial skin and estimate today's condition for each concern on a 0-100 scale where HIGHER = BETTER condition:
- redness (100 = calm, even tone, no visible redness)
- oiliness (100 = balanced, no visible shine)
- moisture (100 = plump, hydrated-looking, no flakiness)
- radiance (100 = luminous, not dull)
- acne (100 = clear, no visible blemishes)
- texture (100 = smooth, refined pores)
Also give skin_type: one of "dry", "normal", "combination", "oily".
Be realistic and kind; most people land between 55 and 90. If lighting, makeup or a filter makes a concern hard to judge, give a middle score (about 70) rather than guessing an extreme.
This is a visual styling read, not a medical assessment — never diagnose.`;

export const SKIN_READ_JSON_SHAPE = `Respond with ONLY a JSON object (no prose, no code fences):
{"scores": {"redness": int, "oiliness": int, "moisture": int, "radiance": int, "acne": int, "texture": int}, "skin_type": "dry"|"normal"|"combination"|"oily"}`;

export interface SkinReadItem {
  type: string;
  ui_score?: number;
  raw_score?: number;
  skin_type?: string;
}

export function validateSkinRead(raw: unknown): SkinReadItem[] {
  const r = raw as { scores?: Record<string, unknown>; skin_type?: unknown };
  const out: SkinReadItem[] = [];
  for (const type of SKIN_CONCERNS) {
    const n = Math.round(Number(r?.scores?.[type]));
    if (Number.isFinite(n)) {
      const score = Math.max(0, Math.min(100, n));
      out.push({ type, ui_score: score, raw_score: score });
    }
  }
  if (out.length < 3) throw new Error('Could not read the selfie — try a clearer, well-lit photo.');
  if (typeof r.skin_type === 'string' && /^(dry|normal|combination|oily)$/i.test(r.skin_type)) {
    out.push({ type: 'skin_type', skin_type: r.skin_type.toLowerCase() });
  }
  return out;
}

export function tryOnPrompt(garment: { label: string; description: string; category: string }): string {
  const scope =
    garment.category === 'upper_body'
      ? 'Replace only their top layer with this garment; keep their existing bottoms, shoes and accessories.'
      : garment.category === 'lower_body'
        ? 'Replace only their bottoms with this garment; keep their existing top, shoes and accessories.'
        : 'Replace their outfit with this garment; keep their shoes and accessories unless the garment covers them.';
  return `Virtual try-on. The FIRST reference image is the person. The SECOND reference image is a garment: ${garment.label}${garment.description ? ` — ${garment.description}` : ''}.
Create a photorealistic photo of exactly the same person from the first image — same face, identity, hair, skin tone, body shape, pose, framing, background and lighting — now wearing the garment from the second image.
${scope}
Reproduce the garment faithfully: same color, print/pattern, fabric texture, neckline, sleeves, length and silhouette, draped naturally on their body with realistic folds and shadows. Ignore any people, text, prices or UI in the garment image.
Output a single natural photo with no text, borders or collage.`;
}

// Output-shape instructions for models without native structured output.
export const GARMENT_JSON_SHAPE = `Respond with ONLY a JSON array (no prose, no code fences). Each element:
{"label": string, "category": "upper_body"|"lower_body"|"full_body", "box_2d": [ymin, xmin, ymax, xmax] (integers 0-1000), "description": string, "confidence": number 0-1}
Return [] if there is no try-on-able garment.`;

export const BRIEF_JSON_SHAPE = `Respond with ONLY a JSON object (no prose, no code fences):
{"headline": string, "summary": string, "care_focus": [{"title": string, "why": string, "action": string}], "palette": {"guidance": string, "wear": [{"hex": "#RRGGBB", "name": string, "why": string}], "avoid": [{"hex": "#RRGGBB", "name": string, "why": string}]}}`;

export const VERDICT_JSON_SHAPE = `Respond with ONLY a JSON object (no prose, no code fences):
{"verdict": "wear_it"|"maybe"|"skip", "score": integer 0-100, "headline": string, "reasons": [string], "skin_harmony": string, "pairing": [string]}`;

// --- Validation --------------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const HEX = /^#[0-9a-f]{6}$/i;
const CATEGORIES = ['upper_body', 'lower_body', 'full_body'] as const;

/** Keep only well-formed garments with finite, in-range, non-degenerate boxes
 * so a bad model box can't produce a zero/negative crop downstream. */
export function validateGarments(raw: unknown): DetectedGarment[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { garments?: unknown })?.garments) ? (raw as { garments: unknown[] }).garments : [];
  const out: DetectedGarment[] = [];
  for (const g of list as Record<string, unknown>[]) {
    if (!g || !isStr(g.label) || !CATEGORIES.includes(g.category as DetectedGarment['category'])) continue;
    const b = g.box_2d;
    if (!Array.isArray(b) || b.length !== 4) continue;
    const box = b.map(Number);
    if (!box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000)) continue;
    const [ymin, xmin, ymax, xmax] = box;
    if (ymax - ymin <= 10 || xmax - xmin <= 10) continue;
    out.push({
      label: g.label,
      category: g.category as DetectedGarment['category'],
      box_2d: box.map(Math.round) as DetectedGarment['box_2d'],
      description: isStr(g.description) ? g.description : '',
      confidence: Number.isFinite(Number(g.confidence)) ? Number(g.confidence) : 0.5,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 6);
}

export function validateBrief(raw: unknown): SkinBrief {
  const r = raw as Record<string, any>;
  if (!r || !isStr(r.headline) || !isStr(r.summary) || !r.palette) throw new Error('Malformed skin brief.');
  const swatches = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .filter((s: any) => s && HEX.test(String(s.hex ?? '').trim()) && isStr(s.name))
      .map((s: any) => ({ hex: String(s.hex).trim(), name: s.name, why: isStr(s.why) ? s.why : '' }));
  const brief: SkinBrief = {
    headline: r.headline,
    summary: r.summary,
    care_focus: (Array.isArray(r.care_focus) ? r.care_focus : [])
      .filter((c: any) => c && isStr(c.title) && isStr(c.action))
      .map((c: any) => ({ title: c.title, why: isStr(c.why) ? c.why : '', action: c.action })),
    palette: {
      guidance: isStr(r.palette.guidance) ? r.palette.guidance : '',
      wear: swatches(r.palette.wear),
      avoid: swatches(r.palette.avoid),
    },
  };
  if (!brief.palette.wear.length) throw new Error('Malformed skin brief.');
  return brief;
}

export function validateVerdict(raw: unknown): StylistVerdict {
  const r = raw as Record<string, any>;
  if (!r || !['wear_it', 'maybe', 'skip'].includes(r.verdict) || !isStr(r.headline)) throw new Error('Malformed verdict.');
  const score = Math.round(Number(r.score));
  return {
    verdict: r.verdict,
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 50,
    headline: r.headline,
    reasons: strList(r.reasons).slice(0, 4),
    skin_harmony: isStr(r.skin_harmony) ? r.skin_harmony : '',
    pairing: strList(r.pairing).slice(0, 3),
  };
}

/** Pull the first JSON value out of a model reply, tolerating code fences or
 * a sentence of preamble. */
export function extractJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    if (start < 0) throw new Error('Model reply contained no JSON.');
    const open = body[start];
    const close = open === '[' ? ']' : '}';
    const end = body.lastIndexOf(close);
    if (end <= start) throw new Error('Model reply contained no JSON.');
    return JSON.parse(body.slice(start, end + 1));
  }
}
