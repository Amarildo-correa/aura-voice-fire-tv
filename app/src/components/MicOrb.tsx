import React, {useEffect, useRef} from 'react';
import {Animated, Easing, StyleSheet, View} from 'react-native';
import Svg, {Circle, Rect, Path, G, Defs, RadialGradient, Stop} from '@amazon-devices/react-native-svg';
import {color, orb as orbT} from '../theme';

export type OrbState = 'idle' | 'listening' | 'processing';

// Orb central: mic em SVG + aneis concentricos que respiram com o nivel
// real da voz (level 0..1). Repouso = ambar; ao vivo = menta; processando =
// arco girando. Toda animacao continua usa transform/opacity (native driver).
function MicOrbBase({level, state}: {level: number; state: OrbState}) {
  const breath = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: orbT.ringDur,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: orbT.ringDur,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);

  useEffect(() => {
    if (state === 'processing') {
      spin.setValue(0);
      const l = Animated.loop(
        Animated.timing(spin, {
          toValue: 1,
          duration: 900,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      l.start();
      return () => l.stop();
    }
  }, [state, spin]);

  const live = state === 'listening';
  const accent = live ? color.live : color.accent;

  // aneis reativos: raio/opacidade seguem o nivel suavizado (dentro do viewBox)
  const r1 = 88 + level * 20;
  const r2 = 90 + level * 28;
  const o1 = live ? 0.2 + level * 0.5 : 0.0;
  const o2 = live ? 0.1 + level * 0.28 : 0.0;

  const breathScale = breath.interpolate({inputRange: [0, 1], outputRange: [1, 1.035]});
  const breathOpacity = breath.interpolate({inputRange: [0, 1], outputRange: [0.5, 0.9]});
  const spinDeg = spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});

  const S = orbT.size;
  return (
    <View style={styles.wrap}>
      {/* aneis reativos (sob o orb) */}
      <Svg width={S} height={S} viewBox="0 0 240 240" style={StyleSheet.absoluteFill}>
        <Circle cx={120} cy={120} r={r2} fill={accent} opacity={o2} />
        <Circle cx={120} cy={120} r={r1} fill={accent} opacity={o1} />
      </Svg>

      {/* arco de processamento */}
      {state === 'processing' && (
        <Animated.View style={[StyleSheet.absoluteFill, {transform: [{rotate: spinDeg}]}]}>
          <Svg width={S} height={S} viewBox="0 0 240 240">
            <Path
              d="M120 26 A94 94 0 0 1 214 120"
              stroke={color.accent}
              strokeWidth={4}
              strokeLinecap="round"
              fill="none"
            />
          </Svg>
        </Animated.View>
      )}

      {/* corpo do orb + mic */}
      <Animated.View style={{transform: [{scale: breathScale}], opacity: state === 'idle' ? breathOpacity : 1}}>
        <Svg width={S} height={S} viewBox="0 0 240 240">
          <Defs>
            <RadialGradient id="orbFill" cx="50%" cy="42%" r="60%">
              <Stop offset="0%" stopColor={color.surfaceFocus} />
              <Stop offset="100%" stopColor={color.surface} />
            </RadialGradient>
          </Defs>
          <Circle cx={120} cy={120} r={84} fill="url(#orbFill)" stroke={accent} strokeWidth={2} opacity={0.98} />
          {/* mic glyph, centrado */}
          <G stroke={accent} strokeWidth={6} strokeLinecap="round" fill="none">
            <Rect x={104} y={84} width={32} height={52} rx={16} fill={accent} stroke="none" />
            <Path d="M94 124 a26 26 0 0 0 52 0" />
            <Path d="M120 150 v16" />
            <Path d="M104 166 h32" />
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {width: orbT.size, height: orbT.size, alignItems: 'center', justifyContent: 'center'},
});

export const MicOrb = React.memo(MicOrbBase);
