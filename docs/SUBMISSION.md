# Devpost submission — copy-paste kit

**Project name:** Anywear

**Tagline (elevator pitch):**
Screenshot any look, anywhere — see it on your own body in seconds, judged honestly for your skin, your colors, and your day.

**Topic:** Skin AI + Apparel VTO (combined)

---

## Text description (paste into "About the project")

### Inspiration

Fashion inspiration lives in screenshots — a shop page, a social post, a street photo — but a screenshot can't answer the two questions that actually decide a purchase: *how does this look on me?* and *does it work for me today?* Meanwhile, the beauty industry treats skin as a separate universe from clothing, even though how a garment reads on you is inseparable from how your skin looks the morning you wear it. Your mirror doesn't separate them; apps do. We built the mirror.

### What it does

Anywear is a fitting room that follows you around the internet, with a stylist inside.

- **Your twin.** One full-body photo becomes your try-on double; one bare-faced selfie becomes your skin baseline. Both stay on your device except when sent to the AI APIs.
- **Skin today.** YouCam **AI Skin Analysis** scores seven concerns (redness, oil balance, moisture, radiance, clarity, texture + skin type and skin age), each with a tappable detection mask you can view on your own face. Gemini then writes a *daily skin brief*: what stands out, one concrete care action per concern — and a wearable color palette for today ("visible redness → skip saturated reds near the face; favor cool sages and light-reflecting neutrals").
- **Try anything you see.** Drop or paste any screenshot. Gemini Vision finds every wearable garment in it — through UI chrome, prices, multiple products — labels it, classifies it (upper / lower / full body), and crops a clean reference image. One tap sends it to YouCam **AI Clothes Virtual Try-On v4**, and seconds later you're wearing it in a draggable before/after mirror.
- **The stylist verdict.** Gemini examines the *actual generated try-on image*, cross-references today's skin brief and your occasion, and delivers a verdict on a garment hang-tag: **Wear it / Maybe / Skip**, with honest, grounded reasons, a skin-harmony note, and pairing suggestions. Change the occasion and the same look gets re-judged — cozy knits that pass "a regular day out" get a frank *Skip it* for "a night out."
- **Lookbook.** Every judged look is kept on-device for side-by-side deciding.

The loop is agentic end-to-end: **measure (Skin AI) → reason (Gemini) → generate (Apparel VTO) → critique (Gemini judge) → decide (you).**

### How we built it

React 19 + Vite + Tailwind v4 SPA, with a Hono (Node) server so API keys never reach the browser. The server implements the full YouCam S2S lifecycle: RSA-encrypted `id_token` auth with token caching, the File API with presigned S3 PUTs, `task/skin-analysis` (7 SD concerns, `enable_mask_overlay`, JSON output with `raw_score`/`ui_score`/`skin_age`), `task/cloth-v4` (garment category from Gemini's classification), task polling, and live credit balance. Gemini (`gemini-3.5-flash` on Vertex AI) powers three reasoning stages with strict JSON schemas: garment detection with normalized bounding boxes, the skin brief, and the stylist verdict. A client-side canvas pipeline downscales uploads, crops garments out of screenshots from Gemini's boxes, and upscales small crops to VTO's minimum input size. All demo people and garments are AI-generated for this project — no third-party photography or trademarks anywhere, including the video.

### Challenges we ran into

- Screenshots are hostile inputs: product pages carry text, prices, buttons, and multiple garments. Tight bounding boxes + padding + minimum-size upscaling made arbitrary screenshots reliably VTO-ready.
- Judging a look credibly requires seeing the *result*, not the inputs — so the verdict stage feeds the generated try-on image back into Gemini, grounded against the measured skin scores rather than generic fashion advice.
- YouCam result URLs expire in 2 hours, so the lookbook stores downscaled on-device copies, and a server proxy shields the client from CORS and expiry.

### Accomplishments we're proud of

The full measure → reason → generate → critique loop runs in under a minute of real API time, and the two YouCam capabilities genuinely compound: skin analysis changes what the stylist says about clothes. The occasion re-judge moment ("Skip it — too cozy-casual for a night out") consistently lands as honest rather than sycophantic.

### What we learned

`raw_score` vs `ui_score` matters (we display consumer-calibrated scores but reason over raw ones); VTO cost/latency (2 units, ~15 s) is low enough for a "try everything you see" habit loop; and an LLM judge with a strict schema + a "be honest, a skip builds trust" prompt produces retail-grade advice.

### What's next

Browser-extension capture (right-click → try it on), makeup transfer from the same screenshot, Face Tone Analysis for seasonal color typing, wardrobe memory ("pair it with things I own"), and shoes/bags via the other YouCam VTO endpoints.

---

## Built with

`react` · `typescript` · `vite` · `tailwindcss` · `hono` · `node.js` · `zustand` · `youcam-api` (AI Skin Analysis, AI Clothes VTO v4, File API) · `gemini` (Vertex AI) · `playwright` (demo capture) · `ffmpeg`

## Submission checklist

- [ ] **Repo URL:** https://github.com/uiharu-kazari/anywear — private, so **invite `contact_event@PerfectCorp.com` as a read collaborator**: GitHub → Settings → Collaborators → Add people → paste the email.
- [ ] **Demo video:** upload `docs/anywear-demo.mp4` (90 s, 1080p, narrated) to YouTube as **Public or Unlisted-public**. Suggested title: "Anywear — screenshot it, wear it (YouCam API Hackathon)". Paste the YouTube link into the submission form.
- [ ] **Screenshots:** use `docs/screenshots/*.png` (welcome, skin brief, garment detection, verdict).
- [ ] **Try-it-out link:** the repo URL (judges run `npm run dev` per README).
