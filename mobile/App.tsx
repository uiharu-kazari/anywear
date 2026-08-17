import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { DetectSweep, DETECT_LINES, RotatingCaption, SkinScanLoader, TailorLoader } from './src/components/Loaders';
import {
  api,
  API,
  pollUntilDone,
  proxied,
  type DetectedGarment,
  type SkinBrief,
  type SkinOutput,
  type StylistVerdict,
} from './src/api';
import { base64ToLocal, cropByBox, pickImage, type LocalImage } from './src/images';
import { colors } from './src/theme';

const CONCERN_NAMES: Record<string, string> = {
  redness: 'Redness',
  oiliness: 'Oil balance',
  moisture: 'Moisture',
  radiance: 'Radiance',
  acne: 'Clarity',
  texture: 'Texture',
};

const OCCASIONS = ['a regular day out', 'the office', 'a first date', 'a night out'];
const SAMPLES = [
  { name: 'street_model.png', label: 'Street style', img: require('./assets/street_model.jpg') },
  { name: 'garment_dress.png', label: 'Slip dress', img: require('./assets/garment_dress.jpg') },
  { name: 'garment_jacket.png', label: 'Blazer', img: require('./assets/garment_jacket.jpg') },
];
const HERO = require('./assets/hero.jpg');
const SCREEN_H = Dimensions.get('window').height;

type Stage =
  | { phase: 'empty' }
  | { phase: 'detecting'; shot: LocalImage }
  | { phase: 'pick'; shot: LocalImage; garments: DetectedGarment[] }
  | { phase: 'running'; garment: DetectedGarment; crop: LocalImage }
  | { phase: 'done'; garment: DetectedGarment; crop: LocalImage; url: string }
  | { phase: 'error'; message: string };

export default function App() {
  const [twin, setTwin] = useState<LocalImage | null>(null);
  const [twinFileId, setTwinFileId] = useState<string | null>(null);
  const [selfie, setSelfie] = useState<LocalImage | null>(null);
  const [skinStatus, setSkinStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [skinOutput, setSkinOutput] = useState<SkinOutput[]>([]);
  const [brief, setBrief] = useState<SkinBrief | null>(null);
  const [occasion, setOccasion] = useState('a regular day out');
  const [customOccasion, setCustomOccasion] = useState('');
  const [stage, setStage] = useState<Stage>({ phase: 'empty' });
  const [verdict, setVerdict] = useState<StylistVerdict | null>(null);
  const [verdictBusy, setVerdictBusy] = useState(false);
  const [verdictError, setVerdictError] = useState(false);
  const [showBefore, setShowBefore] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const verdictSeq = useRef(0); // a returning verdict applies only if it is latest

  // Screenshot/CI mode: EXPO_PUBLIC_AUTODEMO=1 walks the whole demo unattended.
  const autoRan = useRef(false);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_AUTODEMO !== '1' || autoRan.current) return;
    autoRan.current = true;
    void loadDemoPersona();
  }, []);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_AUTODEMO !== '1') return;
    if (twin && selfie && skinStatus === 'idle') void runSkin();
  }, [twin, selfie, skinStatus]);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_AUTODEMO !== '1') return;
    if (['detecting', 'running', 'done'].includes(stage.phase) || verdict) {
      const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 700);
      return () => clearTimeout(t);
    }
  }, [stage.phase, verdict]);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_AUTODEMO !== '1') return;
    if (brief && stage.phase === 'empty' && twin) {
      void (async () => {
        const r = await fetch(`${API}/api/sample/garment_dress.png`).then((x) => x.json());
        const img = await base64ToLocal(r.imageBase64, 'garment_dress.png');
        void submitShot(img);
      })();
    }
  }, [brief, stage.phase, twin]);

  async function loadDemoPersona() {
    try {
      const [p, s] = await Promise.all([
        fetch(`${API}/api/sample/person.png`).then((r) => r.json()),
        fetch(`${API}/api/sample/selfie.png`).then((r) => r.json()),
      ]);
      const twinImg = await base64ToLocal(p.imageBase64, 'demo-person.png');
      const selfieImg = await base64ToLocal(s.imageBase64, 'demo-selfie.png');
      setTwin(twinImg);
      setSelfie(selfieImg);
      setTwinFileId(null);
      void ensureTwinUploaded(twinImg).catch(() => {}); // retried lazily on first try-on
    } catch (err) {
      setStage({ phase: 'error', message: `Could not reach the Anywear server at ${API} — is it running?` });
    }
  }

  async function ensureTwinUploaded(img: LocalImage): Promise<string> {
    if (twinFileId) return twinFileId;
    const { fileId } = await api.uploadPhoto(img.base64);
    setTwinFileId(fileId);
    return fileId;
  }

  async function runSkin() {
    if (!selfie) return;
    setSkinStatus('running');
    setBrief(null);
    try {
      const { taskId } = await api.skinStart(selfie.base64);
      const st = await pollUntilDone(() => api.skinStatus(taskId), 2500);
      if (st.status !== 'success') throw new Error(st.error ?? 'Skin analysis failed.');
      setSkinOutput(st.output ?? []);
      setSkinStatus('done');
      // The brief is a best-effort extra: if Gemini fails here, keep the scores.
      try {
        const concerns = (st.output ?? [])
          .filter((o) => typeof o.ui_score === 'number' && o.type !== 'all')
          .map((o) => ({ type: o.type, raw_score: o.raw_score ?? 0, ui_score: o.ui_score ?? 0 }));
        const res = await api.skinBrief(concerns);
        setBrief(res.brief);
      } catch {
        // scores stay; brief section simply won't render
      }
    } catch {
      setSkinStatus('error');
    }
  }

  async function submitShot(shot: LocalImage) {
    setStage({ phase: 'detecting', shot });
    setVerdict(null);
    try {
      const { garments } = await api.detect(shot.base64);
      if (!garments.length) {
        setStage({ phase: 'error', message: 'No wearable garment found — try a clearer screenshot.' });
        return;
      }
      if (garments.length === 1) return tryGarment(shot, garments[0]);
      setStage({ phase: 'pick', shot, garments });
    } catch (err) {
      setStage({ phase: 'error', message: err instanceof Error ? err.message : 'Detection failed.' });
    }
  }

  async function tryGarment(shot: LocalImage, garment: DetectedGarment) {
    if (!twin) return;
    // Flip out of 'pick' synchronously so a double-tap can't launch two paid
    // try-on tasks while cropByBox is still running.
    setStage({ phase: 'running', garment, crop: { uri: shot.uri, width: shot.width, height: shot.height, base64: '' } });
    try {
      const crop = await cropByBox(shot, garment.box_2d);
      setStage({ phase: 'running', garment, crop });
      const fileId = await ensureTwinUploaded(twin);
      const { taskId } = await api.vtoStart(fileId, crop.base64, garment.category);
      const st = await pollUntilDone(() => api.vtoStatus(taskId));
      if (st.status !== 'success' || !st.url) throw new Error(st.error ?? 'Try-on failed.');
      setStage({ phase: 'done', garment, crop, url: st.url });
      void judge(st.url, garment);
    } catch (err) {
      // A failed try-on may mean the stored twin file expired; drop it so the
      // next attempt re-uploads the photo.
      setTwinFileId(null);
      setStage({ phase: 'error', message: err instanceof Error ? err.message : 'Try-on failed.' });
    }
  }

  async function judge(url: string, garment: DetectedGarment, occ = occasion) {
    const seq = ++verdictSeq.current;
    setVerdictBusy(true);
    setVerdict(null);
    setVerdictError(false);
    try {
      const res = await api.verdict({
        tryOnUrl: url,
        garment: { label: garment.label, description: garment.description },
        occasion: occ,
        brief,
      });
      if (seq !== verdictSeq.current) return; // superseded by a newer request
      setVerdict(res.verdict);
    } catch {
      if (seq === verdictSeq.current) setVerdictError(true);
    } finally {
      if (seq === verdictSeq.current) setVerdictBusy(false);
    }
  }

  const scored = skinOutput.filter((o) => typeof o.ui_score === 'number' && CONCERN_NAMES[o.type]);
  const skinType = skinOutput.find((o) => o.skin_type)?.skin_type;
  const skinAge = skinOutput.find((o) => o.type === 'skin_age')?.score;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <StatusBar barStyle="dark-content" />
        <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll}>
          {twin && (
            <>
              <Text style={styles.brand}>
                Any<Text style={styles.brandItalic}>wear</Text>
              </Text>
              <Text style={styles.tagline}>Screenshot it. Wear it. Styled for your skin — today.</Text>
            </>
          )}

          {/* Welcome */}
          {!twin ? (
            <View style={styles.heroBleed}>
              {/* Full-bleed hero: a real Anywear try-on as the opening image */}
              <View style={[styles.hero, { height: Math.min(480, SCREEN_H * 0.52) }]}>
                <Image source={HERO} style={styles.heroImg} resizeMode="cover" />
                <LinearGradient
                  colors={['rgba(246,244,241,0)', 'rgba(246,244,241,0.55)', colors.porcelain]}
                  locations={[0.45, 0.78, 1]}
                  style={StyleSheet.absoluteFill}
                />
                <View style={styles.heroContent}>
                  <Text style={styles.tag}>your fitting room, everywhere</Text>
                  <Text style={styles.heroBrand}>
                    Any<Text style={styles.brandItalic}>wear</Text>
                  </Text>
                </View>
              </View>

              <View style={styles.heroBody}>
                <Text style={styles.heroTagline}>
                  Screenshot any look, anywhere — see it on your own body in seconds, judged honestly for your skin,
                  your colors, and your day.
                </Text>

                <View style={[styles.row, { marginTop: 18 }]}>
                  <Pressable style={styles.btnPrimary} onPress={loadDemoPersona}>
                    <Text style={styles.btnPrimaryText}>Step in with the demo persona</Text>
                  </Pressable>
                </View>
                <Pressable
                  style={[styles.btnGhost, { marginTop: 10, alignSelf: 'flex-start' }]}
                  onPress={async () => {
                    const img = await pickImage();
                    if (img) {
                      setTwin(img);
                      setTwinFileId(null);
                      void ensureTwinUploaded(img).catch(() => {}); // retried lazily on first try-on
                    }
                  }}
                >
                  <Text style={styles.btnGhostText}>Use my own photos</Text>
                </Pressable>

                <Text style={[styles.tag, { marginTop: 26, marginBottom: 10 }]}>looks you can try in one tap</Text>
                <View style={styles.row}>
                  {SAMPLES.map((s) => (
                    <View key={s.name} style={{ flex: 1 }}>
                      <Image source={s.img} style={styles.welcomeSample} />
                      <Text style={[styles.chipText, { textAlign: 'center', marginTop: 5, color: colors.inkSoft }]}>
                        {s.label}
                      </Text>
                    </View>
                  ))}
                </View>

                <View style={styles.stepRow}>
                  {[
                    ['01', 'Twin', 'One full-body photo becomes your try-on double'],
                    ['02', 'Skin', 'A selfie becomes today’s skin brief and palette'],
                    ['03', 'Wear', 'Any screenshot, on you — judged by your stylist'],
                  ].map(([n, t, d]) => (
                    <View key={n} style={{ flex: 1 }}>
                      <Text style={styles.stepNum}>{n}</Text>
                      <Text style={styles.stepTitle}>{t}</Text>
                      <Text style={styles.stepDesc}>{d}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          ) : (
            <>
              {/* Twin + skin */}
              <View style={[styles.card, styles.rowTop]}>
                <Image source={{ uri: twin.uri }} style={styles.twinThumb} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.tag}>skin today</Text>
                  {!selfie && (
                    <Pressable
                      style={[styles.btnGhost, { marginTop: 8 }]}
                      onPress={async () => {
                        const img = await pickImage();
                        if (img) setSelfie(img);
                      }}
                    >
                      <Text style={styles.btnGhostText}>Add a selfie</Text>
                    </Pressable>
                  )}
                  {selfie && skinStatus === 'idle' && (
                    <Pressable style={[styles.btnBlush, { marginTop: 8 }]} onPress={runSkin}>
                      <Text style={styles.btnPrimaryText}>Read my skin</Text>
                    </Pressable>
                  )}
                  {skinStatus === 'running' && <SkinScanLoader />}
                  {skinStatus === 'error' && (
                    <Text style={[styles.body, { color: colors.brick, marginTop: 8 }]}>
                      Skin analysis failed — try a clearer, closer selfie.
                    </Text>
                  )}
                  {skinStatus === 'done' &&
                    scored.map((o) => (
                      <View key={o.type} style={{ marginTop: 6 }}>
                        <View style={styles.rowBetween}>
                          <Text style={styles.scoreName}>{CONCERN_NAMES[o.type]}</Text>
                          <Text style={styles.scoreNum}>{o.ui_score}</Text>
                        </View>
                        <View style={styles.barTrack}>
                          <View style={[styles.barFill, { width: `${o.ui_score ?? 0}%` }]} />
                        </View>
                      </View>
                    ))}
                  {skinStatus === 'done' && (skinType || skinAge) && (
                    <Text style={[styles.tag, { marginTop: 8 }]}>
                      {skinType ? `type · ${skinType}` : ''}
                      {skinType && skinAge ? '   ' : ''}
                      {skinAge ? `skin age · ${Math.round(skinAge)}` : ''}
                    </Text>
                  )}
                </View>
              </View>

              {brief && (
                <View style={styles.card}>
                  <Text style={styles.briefHeadline}>“{brief.headline}”</Text>
                  <Text style={[styles.body, { marginTop: 6 }]}>{brief.summary}</Text>
                  <Text style={[styles.tag, { marginTop: 12 }]}>today’s palette</Text>
                  <View style={[styles.row, { flexWrap: 'wrap', marginTop: 8 }]}>
                    {brief.palette.wear.map((c) => (
                      <View key={c.hex} style={styles.chip}>
                        <View style={[styles.swatch, { backgroundColor: c.hex }]} />
                        <Text style={styles.chipText}>{c.name}</Text>
                      </View>
                    ))}
                    {brief.palette.avoid.map((c) => (
                      <View key={c.hex} style={[styles.chip, { opacity: 0.55, borderStyle: 'dashed' }]}>
                        <View style={[styles.swatch, { backgroundColor: c.hex }]} />
                        <Text style={[styles.chipText, { textDecorationLine: 'line-through' }]}>{c.name}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {/* Occasion */}
              <View style={styles.card}>
                <Text style={styles.tag}>dressing for</Text>
                <View style={[styles.row, { flexWrap: 'wrap', marginTop: 8 }]}>
                  {OCCASIONS.map((o) => (
                    <Pressable
                      key={o}
                      onPress={() => {
                        setOccasion(o);
                        if (stage.phase === 'done' && !verdictBusy) void judge(stage.url, stage.garment, o);
                      }}
                      style={[styles.occChip, occasion === o && styles.occChipOn]}
                    >
                      <Text style={[styles.chipText, occasion === o && { color: colors.white }]}>{o}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={[styles.row, { marginTop: 8 }]}>
                  <TextInput
                    value={customOccasion}
                    onChangeText={setCustomOccasion}
                    placeholder="or type your own…"
                    placeholderTextColor={colors.inkSoft}
                    style={styles.input}
                    onSubmitEditing={() => {
                      const occ = customOccasion.trim();
                      if (!occ) return;
                      setOccasion(occ);
                      if (stage.phase === 'done' && !verdictBusy) void judge(stage.url, stage.garment, occ);
                    }}
                  />
                </View>
              </View>

              {/* Mirror */}
              <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
                {stage.phase === 'empty' && (
                  <View style={{ padding: 18 }}>
                    <Text style={styles.mirrorTitle}>
                      Try anything <Text style={styles.brandItalic}>you see</Text>
                    </Text>
                    <Text style={[styles.body, { marginTop: 6 }]}>
                      Pick any screenshot — a shop page, a social post, a street photo. Anywear finds the clothes in
                      it.
                    </Text>
                    <Pressable
                      style={[styles.btnPrimary, { marginTop: 12, alignSelf: 'flex-start' }]}
                      onPress={async () => {
                        const img = await pickImage();
                        if (img) void submitShot(img);
                      }}
                    >
                      <Text style={styles.btnPrimaryText}>Choose a screenshot</Text>
                    </Pressable>
                    <Text style={[styles.tag, { marginTop: 16 }]}>or try one of these</Text>
                    <View style={[styles.row, { marginTop: 8 }]}>
                      {SAMPLES.map((s) => (
                        <Pressable
                          key={s.name}
                          style={styles.sampleBtn}
                          onPress={async () => {
                            try {
                              const r = await fetch(`${API}/api/sample/${s.name}`).then((x) => x.json());
                              const img = await base64ToLocal(r.imageBase64, s.name);
                              void submitShot(img);
                            } catch {
                              setStage({ phase: 'error', message: `Could not reach the server at ${API}.` });
                            }
                          }}
                        >
                          <Image source={s.img} style={styles.sampleImg} />
                          <Text style={[styles.chipText, { textAlign: 'center', marginTop: 4 }]}>{s.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}

                {stage.phase === 'detecting' && (
                  <View>
                    <Image
                      source={{ uri: stage.shot.uri }}
                      style={{ width: '100%', aspectRatio: stage.shot.width / stage.shot.height, opacity: 0.75 }}
                    />
                    <DetectSweep />
                    <View style={styles.busyPill}>
                      <RotatingCaption lines={DETECT_LINES} color={colors.ink} />
                    </View>
                  </View>
                )}

                {stage.phase === 'pick' && (
                  <View>
                    <View>
                      <Image
                        source={{ uri: stage.shot.uri }}
                        style={{ width: '100%', aspectRatio: stage.shot.width / stage.shot.height }}
                      />
                      {stage.garments.map((g, i) => {
                        const [ymin, xmin, ymax, xmax] = g.box_2d;
                        return (
                          <Pressable
                            key={i}
                            onPress={() => tryGarment(stage.shot, g)}
                            style={{
                              position: 'absolute',
                              top: `${ymin / 10}%`,
                              left: `${xmin / 10}%`,
                              width: `${(xmax - xmin) / 10}%`,
                              height: `${(ymax - ymin) / 10}%`,
                              borderWidth: 2,
                              borderColor: 'rgba(255,255,255,0.9)',
                              borderRadius: 8,
                            }}
                          >
                            <View style={styles.boxLabel}>
                              <Text style={styles.boxLabelText}>{g.label}</Text>
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>
                    <Text style={[styles.body, { padding: 12, textAlign: 'center' }]}>
                      Found {stage.garments.length} pieces — tap the one you want on you.
                    </Text>
                  </View>
                )}

                {stage.phase === 'running' && twin && (
                  <View>
                    <Image
                      source={{ uri: twin.uri }}
                      style={{ width: '100%', aspectRatio: twin.width / twin.height, opacity: 0.55 }}
                    />
                    <View style={styles.loaderOverlay}>
                      <View style={styles.loaderCard}>
                        <TailorLoader />
                      </View>
                    </View>
                    <Image source={{ uri: stage.crop.uri }} style={styles.cropThumb} />
                  </View>
                )}

                {stage.phase === 'done' && twin && (
                  <View>
                    <Pressable onPressIn={() => setShowBefore(true)} onPressOut={() => setShowBefore(false)}>
                      <Image
                        source={{ uri: showBefore ? twin.uri : proxied(stage.url) }}
                        style={{ width: '100%', aspectRatio: twin.width / twin.height }}
                      />
                      <View style={[styles.busyPill, { top: 12, bottom: undefined }]}>
                        <Text style={styles.tag}>{showBefore ? 'before' : 'in it · hold to compare'}</Text>
                      </View>
                    </Pressable>
                    <View style={[styles.rowBetween, { padding: 12 }]}>
                      <Text style={[styles.scoreName, { flex: 1 }]} numberOfLines={1}>
                        {stage.garment.label}
                      </Text>
                      <Pressable style={styles.btnGhost} onPress={() => setStage({ phase: 'empty' })}>
                        <Text style={styles.btnGhostText}>Try another</Text>
                      </Pressable>
                    </View>
                  </View>
                )}

                {stage.phase === 'error' && (
                  <View style={{ padding: 18 }}>
                    <Text style={styles.mirrorTitle}>That one didn’t work</Text>
                    <Text style={[styles.body, { marginTop: 6 }]}>{stage.message}</Text>
                    <Pressable
                      style={[styles.btnPrimary, { marginTop: 12, alignSelf: 'flex-start' }]}
                      onPress={() => setStage({ phase: 'empty' })}
                    >
                      <Text style={styles.btnPrimaryText}>Start over</Text>
                    </Pressable>
                  </View>
                )}
              </View>

              {/* Verdict */}
              {(verdictBusy || verdict || verdictError) && (
                <View style={[styles.card, styles.tagCard]}>
                  <View style={styles.tagHole} />
                  <Text style={[styles.tag, { textAlign: 'center' }]}>stylist verdict · {occasion}</Text>
                  {verdictBusy && (
                    <View style={{ marginTop: 10 }}>
                      <RotatingCaption
                        lines={[
                          'Looking you over…',
                          'Weighing the color against your brief…',
                          'Judging it for the occasion…',
                          'Being honest, not nice…',
                        ]}
                      />
                    </View>
                  )}
                  {verdictError && !verdictBusy && (
                    <View style={{ marginTop: 10, alignItems: 'center' }}>
                      <Text style={[styles.body, { textAlign: 'center' }]}>The stylist stepped away.</Text>
                      <Pressable
                        style={[styles.btnGhost, { marginTop: 8 }]}
                        onPress={() => stage.phase === 'done' && judge(stage.url, stage.garment)}
                      >
                        <Text style={styles.btnGhostText}>Ask again</Text>
                      </Pressable>
                    </View>
                  )}
                  {verdict && (
                    <>
                      <Text
                        style={[
                          styles.verdictWord,
                          {
                            color:
                              verdict.verdict === 'wear_it'
                                ? colors.sageDeep
                                : verdict.verdict === 'maybe'
                                  ? colors.ochre
                                  : colors.brick,
                          },
                        ]}
                      >
                        {verdict.verdict === 'wear_it' ? '✓ Wear it' : verdict.verdict === 'maybe' ? '≈ Maybe' : '✕ Skip it'}
                      </Text>
                      <Text style={[styles.tag, { textAlign: 'center' }]}>{verdict.score}/100</Text>
                      <Text style={styles.briefHeadline}>“{verdict.headline}”</Text>
                      {verdict.reasons.map((r, i) => (
                        <Text key={i} style={[styles.body, { marginTop: 6 }]}>
                          — {r}
                        </Text>
                      ))}
                      <View style={styles.harmony}>
                        <Text style={[styles.body, { color: colors.blushDeep }]}>{verdict.skin_harmony}</Text>
                      </View>
                    </>
                  )}
                </View>
              )}
            </>
          )}

          <Text style={[styles.tag, { textAlign: 'center', marginVertical: 18 }]}>
            youcam skin ai + apparel vto · gemini · not medical advice
          </Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const serif = { fontFamily: 'Georgia' };

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.porcelain },
  scroll: { padding: 16 },
  brand: { ...serif, fontSize: 40, color: colors.ink, fontWeight: '500' },
  brandItalic: { ...serif, fontStyle: 'italic', color: colors.sageDeep },
  tagline: { color: colors.inkSoft, marginTop: 4, marginBottom: 14, fontSize: 14 },
  tag: {
    fontFamily: 'Menlo',
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.inkSoft,
  },
  body: { color: colors.inkSoft, fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  btnPrimary: {
    backgroundColor: colors.sageDeep,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  btnBlush: {
    backgroundColor: colors.blushDeep,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignSelf: 'flex-start',
  },
  btnPrimaryText: { color: colors.white, fontSize: 13, fontWeight: '600' },
  btnGhost: {
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  btnGhostText: { color: colors.ink, fontSize: 13, fontWeight: '500' },
  twinThumb: { width: 86, aspectRatio: 3 / 4, borderRadius: 12 },
  scoreName: { color: colors.ink, fontSize: 12 },
  scoreNum: { fontFamily: 'Menlo', fontSize: 11, color: colors.inkSoft },
  barTrack: { height: 4, backgroundColor: colors.blushTint, borderRadius: 999, marginTop: 3 },
  barFill: { height: 4, backgroundColor: colors.blush, borderRadius: 999 },
  briefHeadline: { ...serif, fontStyle: 'italic', fontSize: 17, color: colors.ink, marginTop: 8, textAlign: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingRight: 10,
    paddingLeft: 4,
    paddingVertical: 4,
    marginRight: 6,
    marginBottom: 6,
  },
  swatch: { width: 14, height: 14, borderRadius: 999, marginRight: 6 },
  chipText: { fontSize: 11, color: colors.ink },
  occChip: {
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginRight: 6,
    marginBottom: 6,
  },
  occChipOn: { backgroundColor: colors.sageDeep, borderColor: colors.sageDeep },
  input: {
    flex: 1,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
    color: colors.ink,
  },
  mirrorTitle: { ...serif, fontSize: 24, color: colors.ink },
  sampleBtn: { width: 86 },
  sampleImg: { width: 86, aspectRatio: 3 / 4, borderRadius: 10, borderColor: colors.line, borderWidth: 1 },
  busyPill: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(253,252,250,0.92)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  boxLabel: {
    position: 'absolute',
    top: -20,
    left: 2,
    backgroundColor: colors.ink,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  boxLabelText: { color: colors.white, fontSize: 9, fontFamily: 'Menlo' },
  cropThumb: {
    position: 'absolute',
    right: 12,
    bottom: 54,
    width: 64,
    aspectRatio: 3 / 4,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.paper,
  },
  tagCard: { transform: [{ rotate: '-1.5deg' }], paddingTop: 20 },
  tagHole: {
    position: 'absolute',
    top: 8,
    alignSelf: 'center',
    width: 10,
    height: 10,
    borderRadius: 999,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.porcelain,
  },
  verdictWord: { ...serif, fontSize: 30, textAlign: 'center', marginTop: 6, marginBottom: 2 },
  heroBleed: { marginTop: -16, marginHorizontal: -16, backgroundColor: colors.porcelain },
  hero: { width: '100%', justifyContent: 'flex-end', overflow: 'hidden', backgroundColor: colors.porcelain },
  heroImg: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
  heroContent: { paddingHorizontal: 22, paddingBottom: 2, gap: 6 },
  heroBrand: { ...serif, fontSize: 64, color: colors.ink, fontWeight: '500', lineHeight: 68 },
  heroBody: { paddingHorizontal: 22, paddingTop: 8, backgroundColor: colors.porcelain },
  heroTagline: { color: colors.inkSoft, fontSize: 16, lineHeight: 24, fontWeight: '300' },
  welcomeSample: { width: '100%', aspectRatio: 3 / 4, borderRadius: 12, borderWidth: 1, borderColor: colors.line },
  stepRow: { flexDirection: 'row', gap: 14, marginTop: 26, marginBottom: 8 },
  stepNum: { fontFamily: 'Menlo', fontSize: 11, color: colors.sageDeep, marginBottom: 4 },
  stepTitle: { ...serif, fontSize: 18, color: colors.ink, marginBottom: 3 },
  stepDesc: { fontSize: 11, lineHeight: 16, color: colors.inkSoft },
  loaderOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  loaderCard: {
    backgroundColor: 'rgba(253,252,250,0.94)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 22,
    paddingVertical: 6,
  },
  harmony: {
    backgroundColor: colors.blushTint,
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
  },
});
