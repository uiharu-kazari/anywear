// Generate royalty-free demo assets with Gemini image generation.
// Usage: node scripts/gen-samples.mjs [name ...]  (default: all)
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';

const ai = process.env.GOOGLE_CLOUD_PROJECT
  ? new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION ?? 'global' })
  : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const OUT = path.join(process.cwd(), 'public', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const IMAGE_MODELS = ['gemini-3.1-flash-image', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-image'];

const PROMPTS = {
  person: `Full-body studio photograph of a woman in her late 20s standing straight, facing the camera directly, arms relaxed at her sides, full body visible head to shoes. She wears a plain fitted white t-shirt and simple straight blue jeans with white sneakers. Neutral light-gray seamless studio background, soft even lighting, entire body sharp and unobstructed, no props, no text. Portrait orientation 3:4, photorealistic.`,
  selfie: `Close-up front-facing selfie portrait of the same woman in her late 20s, bare face with no makeup, neutral expression, hair pulled back, forehead visible, face filling about 70% of the frame width, even soft daylight, sharp focus, plain background, no text. Portrait orientation, photorealistic, natural skin texture with slight redness on cheeks and mild under-eye circles.`,
  garment_dress: `E-commerce product photograph of a single sage-green satin slip midi dress with thin straps, displayed on an invisible ghost mannequin, front view, centered, plain white background, soft studio lighting, no model, no text, no watermark. Portrait orientation 3:4.`,
  garment_jacket: `E-commerce product photograph of a single camel-brown oversized wool blazer, displayed on an invisible ghost mannequin, front view, centered, plain white background, soft studio lighting, no model, no text, no watermark. Portrait orientation 3:4.`,
  street_model: `Street style fashion photograph of a woman standing on a city sidewalk wearing a burnt-orange ribbed knit sweater tucked into a pleated cream midi skirt, full outfit visible, front view, golden hour light, shallow depth of field, no visible logos or text. Portrait orientation 3:4, photorealistic.`,
};

async function gen(name, prompt) {
  for (const model of IMAGE_MODELS) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      const parts = res.candidates?.[0]?.content?.parts ?? [];
      const img = parts.find((p) => p.inlineData?.data);
      if (!img) throw new Error('no image in response');
      const ext = img.inlineData.mimeType?.includes('png') ? 'png' : 'jpg';
      const file = path.join(OUT, `${name}.${ext}`);
      fs.writeFileSync(file, Buffer.from(img.inlineData.data, 'base64'));
      console.log(`OK ${name} <- ${model} -> ${file} (${fs.statSync(file).size} bytes)`);
      return;
    } catch (err) {
      console.log(`   ${name}: ${model} failed: ${String(err).slice(0, 140)}`);
    }
  }
  console.log(`FAIL ${name}`);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PROMPTS);
for (const name of names) await gen(name, PROMPTS[name]);
