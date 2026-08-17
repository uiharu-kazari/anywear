import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
const ai = new GoogleGenAI({ vertexai: true, project: 'project-8b7cf02e-3e1c-451c-9be', location: 'global' });
for (const model of ['gemini-3-flash-preview-tts', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts']) {
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Say warmly: This is Anywear. Your fitting room, everywhere.' }] }],
      config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } },
    });
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part) throw new Error('no audio');
    fs.writeFileSync('/tmp/tts_test.raw', Buffer.from(part.inlineData.data, 'base64'));
    console.log('OK', model, part.inlineData.mimeType, fs.statSync('/tmp/tts_test.raw').size);
    break;
  } catch (e) { console.log('ERR', model, String(e).slice(0, 140)); }
}
