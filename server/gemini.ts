import { GoogleGenAI, Type } from '@google/genai';
import {
  GARMENT_PROMPT,
  skinBriefPrompt,
  verdictPrompt,
  validateBrief,
  validateGarments,
  validateVerdict,
  type DetectedGarment,
  type SkinBrief,
  type StylistVerdict,
} from '../shared/prompts.js';

export type { DetectedGarment, SkinBrief, StylistVerdict };

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

/**
 * Find wearable garments in any screenshot (e-commerce page, social post,
 * street photo). Returns tight bounding boxes so the client can crop a clean
 * reference image for the VTO call.
 */
export async function detectGarments(imageBase64: string, mimeType: string): Promise<DetectedGarment[]> {
  const out = await generateJSON({
    parts: [
      { inlineData: { data: imageBase64, mimeType } },
      {
        text: GARMENT_PROMPT,
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
  });
  return validateGarments(out);
}

/**
 * Turn raw skin-analysis scores into a human "today's skin brief":
 * state summary, top care priorities, and a wearable color palette that
 * flatters today's complexion. This is styling guidance, not medical advice.
 */
export async function skinBrief(concerns: { type: string; raw_score: number; ui_score: number }[]): Promise<SkinBrief> {
  return validateBrief(await generateJSON({
    parts: [
      {
        text: skinBriefPrompt(concerns),
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
  }));
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
  return validateVerdict(await generateJSON({
    parts: [
      { inlineData: { data: opts.tryOnImageBase64, mimeType: opts.mimeType } },
      {
        text: verdictPrompt(opts),
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
  }));
}
