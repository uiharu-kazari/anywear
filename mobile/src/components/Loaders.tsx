// Waiting states that feel like the work being done: a face scan for skin
// analysis, a tailor's stitch-line for try-on, a viewfinder sweep for garment
// detection. Static SVG line art + RN Animated overlays (no native deps
// beyond react-native-svg, which ships inside Expo Go).
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Ellipse, Line, Path } from 'react-native-svg';
import { colors } from '../theme';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Fades between rotating status captions. */
export function RotatingCaption(props: { lines: string[]; color?: string; intervalMs?: number }) {
  const [i, setI] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const id = setInterval(() => {
      Animated.timing(fade, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => {
        setI((n) => (n + 1) % props.lines.length);
        Animated.timing(fade, { toValue: 1, duration: 320, useNativeDriver: true }).start();
      });
    }, props.intervalMs ?? 2100);
    return () => clearInterval(id);
  }, [props.lines.length, props.intervalMs, fade]);
  return (
    <Animated.Text style={[styles.caption, { opacity: fade, color: props.color ?? colors.inkSoft }]}>
      {props.lines[i]}
    </Animated.Text>
  );
}

function useLoop(durationMs: number) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: durationMs, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [v, durationMs]);
  return v;
}

const SKIN_LINES = [
  'Reading redness…',
  'Measuring moisture…',
  'Checking radiance…',
  'Mapping texture…',
  'Weighing oil balance…',
  'Estimating skin age…',
];

/** Face line-art with a sweeping scan line and pulse rings — skin analysis. */
export function SkinScanLoader() {
  const sweep = useLoop(2200);
  const pulse = useLoop(1800);
  const translateY = sweep.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 96, 0] });
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.5] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.5, 0] });
  return (
    <View style={styles.wrap}>
      <View style={{ width: 96, height: 116 }}>
        <Svg width={96} height={116} viewBox="0 0 96 116">
          {/* face */}
          <Path
            d="M48 8 C70 8 80 26 80 48 C80 76 66 100 48 100 C30 100 16 76 16 48 C16 26 26 8 48 8 Z"
            stroke={colors.blush}
            strokeWidth={2}
            fill="none"
          />
          {/* eyes */}
          <Path d="M30 48 Q36 43 42 48" stroke={colors.blushDeep} strokeWidth={2} fill="none" strokeLinecap="round" />
          <Path d="M54 48 Q60 43 66 48" stroke={colors.blushDeep} strokeWidth={2} fill="none" strokeLinecap="round" />
          {/* nose + lips */}
          <Path d="M48 54 L46 66 Q48 68 50 66" stroke={colors.blush} strokeWidth={1.6} fill="none" strokeLinecap="round" />
          <Path d="M40 80 Q48 85 56 80" stroke={colors.blushDeep} strokeWidth={2} fill="none" strokeLinecap="round" />
          {/* cheeks */}
          <Ellipse cx="30" cy="63" rx="6" ry="3.4" fill={colors.blushTint} />
          <Ellipse cx="66" cy="63" rx="6" ry="3.4" fill={colors.blushTint} />
        </Svg>
        {/* scan line */}
        <Animated.View style={[styles.scan, { transform: [{ translateY }] }]} />
        {/* pulse ring */}
        <Animated.View style={[styles.ring, { opacity: ringOpacity, transform: [{ scale: ringScale }] }]} />
      </View>
      <RotatingCaption lines={SKIN_LINES} color={colors.blushDeep} />
    </View>
  );
}

const TAILOR_LINES = [
  'Cutting the pattern…',
  'Reading the drape…',
  'Pinning the hem…',
  'Matching the light…',
  'Pressing the seams…',
  'One last look in the mirror…',
];

/** Hanger + dress drawn as a marching stitch line — clothes try-on. */
export function TailorLoader() {
  const stitch = useRef(new Animated.Value(0)).current;
  const needle = useLoop(2600);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(stitch, { toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: false }),
    );
    loop.start();
    return () => loop.stop();
  }, [stitch]);
  const dashOffset = stitch.interpolate({ inputRange: [0, 1], outputRange: [0, -28] });
  const needleX = needle.interpolate({ inputRange: [0, 0.5, 1], outputRange: [-34, 34, -34] });
  return (
    <View style={styles.wrap}>
      <View style={{ width: 110, height: 120 }}>
        <Svg width={110} height={120} viewBox="0 0 110 120">
          {/* hanger */}
          <Path d="M55 6 Q62 6 62 12 Q62 17 55 19 L55 24" stroke={colors.sageDeep} strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <Path d="M55 24 L18 40 Q16 41 18 42 L92 42 Q94 41 92 40 Z" stroke={colors.sageDeep} strokeWidth={2.4} fill="none" strokeLinejoin="round" />
          {/* dress outline, stitched */}
          <AnimatedPath
            d="M40 48 L44 60 Q55 66 66 60 L70 48 M44 60 L34 104 Q55 114 76 104 L66 60"
            stroke={colors.sage}
            strokeWidth={2.2}
            fill="none"
            strokeLinecap="round"
            strokeDasharray="7 7"
            strokeDashoffset={dashOffset as unknown as number}
          />
          {/* measuring tape ticks */}
          <Line x1="14" y1="116" x2="96" y2="116" stroke={colors.line} strokeWidth={3} strokeLinecap="round" />
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <Line key={i} x1={20 + i * 12} y1={113} x2={20 + i * 12} y2={119} stroke={colors.inkSoft} strokeWidth={1} />
          ))}
        </Svg>
        {/* needle glint sliding along the tape */}
        <Animated.View style={[styles.needle, { transform: [{ translateX: needleX }] }]} />
      </View>
      <RotatingCaption lines={TAILOR_LINES} color={colors.sageDeep} />
    </View>
  );
}

export const DETECT_LINES = ['Reading the look…', 'Spotting the pieces…', 'Tracing the outlines…', 'Cropping it clean…'];

/** Viewfinder sweep laid over the screenshot — garment detection. */
export function DetectSweep() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* corner brackets */}
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <View key={c} style={[styles.corner, styles[c]]} />
      ))}
      <SweepBar />
    </View>
  );
}

/** The moving bar for DetectSweep, isolated so it can size to its parent. */
function SweepBar() {
  const [h, setH] = useState(0);
  const sweep = useLoop(2000);
  const translateY = sweep.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, Math.max(0, h - 3), 0] });
  return (
    <View style={StyleSheet.absoluteFill} onLayout={(e) => setH(e.nativeEvent.layout.height)} pointerEvents="none">
      <Animated.View style={[styles.sweepLine, { transform: [{ translateY }] }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 14 },
  caption: { fontSize: 13, fontWeight: '500', textAlign: 'center' },
  scan: {
    position: 'absolute',
    top: 8,
    left: 4,
    right: 4,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: colors.blush,
    shadowColor: colors.blushDeep,
    shadowOpacity: 0.7,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  ring: {
    position: 'absolute',
    top: 28,
    left: 18,
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 1.5,
    borderColor: colors.blush,
  },
  needle: {
    position: 'absolute',
    bottom: 0,
    left: 47,
    width: 16,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.sageTint,
    borderWidth: 1.5,
    borderColor: colors.sageDeep,
  },
  sweepLine: {
    position: 'absolute',
    left: 6,
    right: 6,
    top: 0,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.95)',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
  corner: {
    position: 'absolute',
    width: 26,
    height: 26,
    borderColor: 'rgba(255,255,255,0.95)',
  },
  tl: { top: 10, left: 10, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  tr: { top: 10, right: 10, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  bl: { bottom: 10, left: 10, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
  br: { bottom: 10, right: 10, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },
});
