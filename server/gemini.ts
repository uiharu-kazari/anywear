import { GoogleGenAI, Type } from '@google/genai';

// Prefer Vertex AI with Application Default Credentials
// (`gcloud auth application-default login`); fall back to an API key.
const ai = process.env.GOOGLE_CLOUD_PROJECT
  ? new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? 'global',
    })
  : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Newest-first; fall back if a model id is not available on this project/key.
const MODELS = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];

async function generateJSON(opts: {
  parts: object[];
  system?: string;
  schema: object;
}): Promise<unknown> {
  let lastErr: unknown;
  for (const model of MODELS) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: opts.parts }],
        config: {
          ...(opts.system ? { systemInstruction: opts.system } : {}),
          responseMimeType: 'application/json',
          responseSchema: opts.schema,
          temperature: 0.4,
        },
      });
      const text = res.text;
      if (!text) throw new Error('empty response');
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export interface DetectedGarment {
  label: string;
  category: 'upper_body' | 'lower_body' | 'full_body';
  box_2d: [number, number, number, number]; // ymin, xmin, ymax, xmax in 0-1000
  description: string;
  confidence: number;
}

/**
 * Find wearable garments in any screenshot (e-commerce page, social post,
 * street photo). Returns tight bounding boxes so the client can crop a clean
 * reference image for the VTO call.
 */
export async function detectGarments(imageBase64: string, mimeType: string): Promise<DetectedGarment[]> {
  const out = (await generateJSON({
    parts: [
      { inlineData: { data: imageBase64, mimeType } },
      {
        text: `Detect every distinct wearable clothing item in this image that could be virtually tried on.
The image may be a messy phone screenshot: e-commerce product pages, social media posts, street style photos — possibly containing UI chrome, text, prices, buttons, multiple products.

For each garment return:
- label: short shopper-friendly name (e.g. "Linen blazer", "Pleated midi skirt")
- category: "upper_body" (tops, shirts, jackets), "lower_body" (pants, skirts, shorts) or "full_body" (dresses, jumpsuits, full outfits/co-ords)
- box_2d: TIGHT bounding box [ymin, xmin, ymax, xmax] scaled 0-1000, covering the garment itself and cropping away surrounding UI, text and unrelated background as much as possible. If the garment is worn by a model, include the worn garment region.
- description: one sentence: color, fabric/texture, silhouette, styling notes
- confidence: 0-1 that this is a clearly try-on-able garment

Rules: skip shoes, bags, hats, jewelry, accessories. Skip garments that are mostly occluded or under ~15% of the image. If one model wears a complete matching outfit, you may return it as one full_body item in addition to its parts. Order by confidence descending, max 6 items.`,
      },
    ],
    schema: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          category: { type: Type.STRING, enum: ['upper_body', 'lower_body', 'full_body'] },
          box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER }, minItems: 4, maxItems: 4 },
          description: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
        required: ['label', 'category', 'box_2d', 'description', 'confidence'],
        propertyOrdering: ['label', 'category', 'box_2d', 'description', 'confidence'],
      },
    },
  })) as DetectedGarment[];
  return out.filter((g) => Array.isArray(g.box_2d) && g.box_2d.length === 4);
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

/**
 * Turn raw skin-analysis scores into a human "today's skin brief":
 * state summary, top care priorities, and a wearable color palette that
 * flatters today's complexion. This is styling guidance, not medical advice.
 */
export async function skinBrief(concerns: { type: string; raw_score: number; ui_score: number }[]): Promise<SkinBrief> {
  return (await generateJSON({
    parts: [
      {
        text: `You are a stylist-facing skin interpreter inside a fashion app. Input: today's AI skin analysis of the user (scores 0-100, HIGHER = BETTER condition for that concern).

${JSON.stringify(concerns, null, 2)}

Produce today's "skin brief":
- headline: 4-8 word friendly headline about today's skin state (no alarmism)
- summary: 2 sentences interpreting the standout scores (mention the 2 best and 2 most-in-need areas by name, plain language)
- care_focus: the 2-3 lowest-scoring concerns as {title, why (1 sentence, tie to the score), action (1 concrete same-day skincare/lifestyle action)}
- palette: clothing color guidance for TODAY based on skin state (e.g. visible redness → avoid saturated reds near the face that amplify it, favor cool sages/blues; dullness/low radiance → luminous warm tones lift; dark circles → avoid draining muddy tones near face). guidance: 1-2 sentences of overall logic. wear: 4 colors {hex, name, why}. avoid: 2 colors {hex, name, why}. Hex values must be realistic wearable clothing colors.

Never give medical claims or product brand names. Tone: warm, specific, zero fluff.`,
      },
    ],
    schema: {
      type: Type.OBJECT,
      properties: {
        headline: { type: Type.STRING },
        summary: { type: Type.STRING },
        care_focus: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              why: { type: Type.STRING },
              action: { type: Type.STRING },
            },
            required: ['title', 'why', 'action'],
          },
        },
        palette: {
          type: Type.OBJECT,
          properties: {
            guidance: { type: Type.STRING },
            wear: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: { hex: { type: Type.STRING }, name: { type: Type.STRING }, why: { type: Type.STRING } },
                required: ['hex', 'name', 'why'],
              },
            },
            avoid: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: { hex: { type: Type.STRING }, name: { type: Type.STRING }, why: { type: Type.STRING } },
                required: ['hex', 'name', 'why'],
              },
            },
          },
          required: ['guidance', 'wear', 'avoid'],
        },
      },
      required: ['headline', 'summary', 'care_focus', 'palette'],
    },
  })) as SkinBrief;
}

export interface StylistVerdict {
  verdict: 'wear_it' | 'maybe' | 'skip';
  score: number;
  headline: string;
  reasons: string[];
  skin_harmony: string;
  pairing: string[];
}

/**
 * Judge a finished try-on result against the user's skin brief and occasion.
 * Sees the actual generated try-on image, so the judgment is grounded in what
 * the garment really looks like on this person.
 */
export async function stylistVerdict(opts: {
  tryOnImageBase64: string;
  mimeType: string;
  garment: { label: string; description: string };
  occasion: string;
  brief?: SkinBrief | null;
}): Promise<StylistVerdict> {
  const briefText = opts.brief
    ? `Today's skin brief for this user:\n${JSON.stringify({ headline: opts.brief.headline, summary: opts.brief.summary, palette: opts.brief.palette }, null, 2)}`
    : 'No skin analysis available — judge on fit, color harmony with visible complexion, and occasion only.';
  return (await generateJSON({
    parts: [
      { inlineData: { data: opts.tryOnImageBase64, mimeType: opts.mimeType } },
      {
        text: `You are an honest personal stylist. This image is an AI-generated virtual try-on of YOUR CLIENT actually wearing: ${opts.garment.label} — ${opts.garment.description}.
Occasion they are dressing for: "${opts.occasion}".
${briefText}

Judge THIS look on THIS person:
- verdict: "wear_it" | "maybe" | "skip"
- score: 0-100 overall
- headline: one punchy sentence a friend would text back
- reasons: 2-4 short concrete observations grounded in what you SEE (silhouette on their frame, color against their complexion, occasion fit). Be honest — a "skip" with a good reason builds trust.
- skin_harmony: 1 sentence on how the garment color interacts with today's skin palette guidance (or visible complexion if no brief)
- pairing: 2-3 quick suggestions to complete the look (shoes/layer/accessory categories, no brands)

Never mention that the image is AI-generated. Never comment on body size or weight — only silhouette and cut.`,
      },
    ],
    schema: {
      type: Type.OBJECT,
      properties: {
        verdict: { type: Type.STRING, enum: ['wear_it', 'maybe', 'skip'] },
        score: { type: Type.INTEGER },
        headline: { type: Type.STRING },
        reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
        skin_harmony: { type: Type.STRING },
        pairing: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['verdict', 'score', 'headline', 'reasons', 'skin_harmony', 'pairing'],
    },
  })) as StylistVerdict;
}
