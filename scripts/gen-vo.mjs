import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
const ai = new GoogleGenAI({ vertexai: true, project: 'project-8b7cf02e-3e1c-451c-9be', location: 'global' });
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const LINES = [
  ['vo01', 'This is Anywear. Your fitting room, everywhere.'],
  ['vo02', 'One full-body photo and one selfie become your twin.'],
  ['vo03', 'YouCam Skin Analysis reads seven concerns in seconds. Real scores, skin type, and skin age.'],
  ['vo04', 'Gemini turns those scores into a daily brief. Care actions, and the colors to wear today.'],
  ['vo05', 'Now drop in any screenshot. Gemini finds every garment, labels it, and crops it clean.'],
  ['vo06', "One tap sends it to YouCam's Apparel Try-On."],
  ['vo07', 'And there you are. Drag the mirror. Before... and in it.'],
  ['vo08', "An honest stylist judges the actual result, against today's skin brief."],
  ['vo09', 'Change the occasion, and the verdict changes with it. Too cozy for a night out? Skip it.'],
  ['vo10', "Product shots work too. This dress comes straight from today's palette."],
  ['vo11', 'Every look lands in your lookbook. Anywear. Screenshot it. Wear it.'],
];
for (const [name, text] of LINES) {
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [{ role: 'user', parts: [{ text: `Narrate warmly, briskly and confidently, like a premium product film: ${text}` }] }],
    config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } },
  });
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) { console.log('FAIL', name); continue; }
  fs.writeFileSync(`${OUT}/${name}.raw`, Buffer.from(part.inlineData.data, 'base64'));
  console.log('OK', name);
}
