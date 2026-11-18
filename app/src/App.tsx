import React, {useCallback, useEffect, useRef, useState} from 'react';
import {BackHandler, StyleSheet, Text, View} from 'react-native';
import {
  SecurityManager,
  PrivilegeState,
} from '@amazon-devices/security-manager-lib';
import {
  AudioRecordStreamBuilder,
  AudioSource,
  AudioSampleRate,
  AudioChannelMask,
  AudioSampleFormat,
} from '@amazon-devices/keplerscript-audio-lib';
import Svg, {Rect} from '@amazon-devices/react-native-svg';
import {MicOrb, OrbState} from './components/MicOrb';
import {color, font, space, orb as orbT} from './theme';

const RELAY = 'http://192.168.1.4:8899';
const MIC_PRIVILEGE = 'com.amazon.audio.privilege.microphone.access';

// Instrumentacao fora da UI: vai para o relay (/log), lido nas saidas de log.
function log(msg: string): void {
  fetch(RELAY + '/log', {method: 'POST', body: msg}).catch(() => {});
}
function cutAlexaFeedback(): void {
  fetch(RELAY + '/back', {method: 'GET'}).catch(() => {});
}

function pcmToWav(samples: Int16Array, sr: number): ArrayBuffer {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const wr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  wr(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  wr(8, 'WAVE');
  wr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wr(36, 'data');
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return buf;
}

// Captura "como a Alexa nativa": grava do momento em que o controle comeca a
// transmitir ate ele PARAR (botao solto). Nao corta em pausas da fala — so
// encerra quando o audio vira silencio-real (o controle deixou de transmitir).
const SR = 16000;
const START_TH = 600; // inicia captura quando ha transmissao/fala
const RELEASE_FLOOR = 25; // pico abaixo disso = controle parou (botao solto)
const RELEASE_HOLD = SR * 2 * 0.5; // 0,5s de silencio-real encerra
const MIN_UTTER = SR * 0.25; // amostras minimas p/ enviar
const MAX_UTTER = SR * 20; // teto de seguranca

function Brand() {
  return (
    <View style={styles.brand}>
      <Svg width={22} height={22} viewBox="0 0 26 26">
        <Rect x={6} y={6} width={14} height={14} rx={4} transform="rotate(45 13 13)" fill={color.accent} />
      </Svg>
      <Text style={styles.brandName}>Aura</Text>
      <View style={styles.brandDivider} />
      <Text style={styles.brandSection}>Busca por voz</Text>
    </View>
  );
}

function StatusChip({state}: {state: OrbState}) {
  const map = {
    idle: {c: color.muted, t: 'Pronto'},
    listening: {c: color.live, t: 'Ouvindo'},
    processing: {c: color.accent, t: 'Transcrevendo'},
  } as const;
  const s = map[state];
  return (
    <View style={styles.statusChip}>
      <View style={[styles.statusDot, {backgroundColor: s.c}]} />
      <Text style={[styles.statusText, {color: s.c}]}>{s.t}</Text>
    </View>
  );
}

export const App = () => {
  const [query, setQuery] = useState('');
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [level, setLevel] = useState(0);
  const mounted = useRef(true);
  const vad = useRef({capturing: false, releaseRun: 0, backSent: false});
  const bufRef = useRef<number[]>([]);
  const lastPush = useRef(0);

  // app nunca sai por BACK (o KEY_BACK injetado para cortar a Alexa e inofensivo)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const processUtterance = useCallback(async (pcm: Int16Array) => {
    if (!mounted.current || pcm.length < MIN_UTTER) {
      setOrbState('idle');
      return;
    }
    setOrbState('processing');
    setLevel(0);
    try {
      const res = await fetch(RELAY + '/stt', {
        method: 'POST',
        headers: {'Content-Type': 'audio/wav'},
        body: pcmToWav(pcm, SR),
      });
      const j = await res.json();
      const t = (j.text || '').trim();
      log('stt=' + JSON.stringify(t));
      if (mounted.current && t) setQuery(t);
    } catch (e) {
      log('stt erro: ' + String(e));
    }
    if (mounted.current) setOrbState('idle');
  }, []);

  useEffect(() => {
    mounted.current = true;
    let stream: any;
    (async () => {
      log('tela montada; solicitando privilégio de mic');
      let st: PrivilegeState;
      try {
        st = await SecurityManager.requestPrivilege(MIC_PRIVILEGE);
      } catch (e) {
        log('requestPrivilege erro: ' + String(e));
        return;
      }
      if (st !== PrivilegeState.ALLOW) {
        log('privilégio de mic negado');
        return;
      }
      const b = new AudioRecordStreamBuilder();
      b.setAudioConfig({
        sampleRate: AudioSampleRate.SAMPLE_RATE_16_KHZ,
        channelMask: AudioChannelMask.CHANNEL_MONO,
        format: AudioSampleFormat.FORMAT_PCM_16_BIT,
      });
      b.setAudioSource(AudioSource.VOICE_RECOGNITION);
      try {
        stream = await b.buildAsync();
      } catch (e) {
        log('buildAsync erro: ' + String(e));
        return;
      }
      let minBuf = 3200;
      try {
        await stream.initCheckAsync();
        minBuf = (await stream.getMinBufferSizeInBytesAsync()) || 3200;
      } catch {}
      const chunk = Math.max(minBuf, 3200);
      log('escutando (auto): segure o botão de voz e fale');
      let smooth = 0;
      while (mounted.current) {
        let buf: ArrayBuffer;
        try {
          buf = await stream.readAsync(chunk);
        } catch (e) {
          log('readAsync erro: ' + String(e));
          break;
        }
        const view = new Int16Array(buf);
        let peak = 0;
        for (let i = 0; i < view.length; i++) {
          const a = view[i] < 0 ? -view[i] : view[i];
          if (a > peak) peak = a;
        }
        const inst = Math.min(1, peak / 9000);
        smooth = smooth * 0.6 + inst * 0.4;
        const now = Date.now();
        if (now - lastPush.current > 80) {
          lastPush.current = now;
          setLevel(smooth);
        }

        const v = vad.current;
        if (!v.capturing) {
          // ainda nao gravando: comeca quando o controle transmite (fala)
          if (peak >= START_TH) {
            v.capturing = true;
            v.releaseRun = 0;
            v.backSent = false;
            bufRef.current = [];
            setOrbState('listening');
            log('gravando (segure; só encerra ao soltar)');
            for (let i = 0; i < view.length; i++) bufRef.current.push(view[i]);
          }
        } else {
          // SEGURANDO: grava TUDO (inclusive pausas) ate o controle parar
          for (let i = 0; i < view.length; i++) bufRef.current.push(view[i]);
          if (peak < RELEASE_FLOOR) {
            v.releaseRun += buf.byteLength; // silencio-real acumulando
          } else {
            v.releaseRun = 0; // ainda transmitindo (fala ou pausa com ruido)
          }
          const tooLong = bufRef.current.length > MAX_UTTER;
          if (v.releaseRun >= RELEASE_HOLD || tooLong) {
            v.capturing = false;
            if (!v.backSent) {
              v.backSent = true;
              cutAlexaFeedback(); // soltou -> corta o overlay/áudio da Alexa
            }
            const pcm = Int16Array.from(bufRef.current);
            bufRef.current = [];
            log('soltou: ' + pcm.length + ' amostras');
            processUtterance(pcm);
          }
        }
      }
      try {
        await AudioRecordStreamBuilder.destroyAsync(stream);
      } catch {}
      log('tela desmontada; stream fechado');
    })();
    return () => {
      mounted.current = false;
    };
  }, [processUtterance]);

  const hint =
    orbState === 'listening'
      ? 'Ouvindo… (solte o botão para enviar)'
      : orbState === 'processing'
      ? 'Transcrevendo…'
      : 'Segure o botão de voz do controle e fale';

  return (
    <View style={styles.screen}>
      {/* grupo de voz centralizado na tela inteira */}
      <View style={styles.center} pointerEvents="none">
        <View style={styles.queryBox}>
          <Text style={[styles.query, !query && styles.prompt]} numberOfLines={2}>
            {query || 'O que você quer assistir?'}
          </Text>
        </View>
        <View style={styles.orbHolder}>
          <MicOrb level={level} state={orbState} />
        </View>
        <Text style={styles.hint}>{hint}</Text>
      </View>

      {/* header ancorado no topo */}
      <View style={styles.header}>
        <Brand />
        <StatusChip state={orbState} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: color.bg},
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.safeX,
  },
  header: {
    position: 'absolute',
    top: space.safeY,
    left: space.safeX,
    right: space.safeX,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: {flexDirection: 'row', alignItems: 'center'},
  brandName: {
    color: color.text,
    fontSize: font.title,
    fontFamily: font.family,
    fontWeight: '700',
    marginLeft: 10,
  },
  brandDivider: {width: 1, height: 16, backgroundColor: color.hairline, marginHorizontal: 12},
  brandSection: {color: color.muted, fontSize: font.tag, fontFamily: font.family},
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  statusDot: {width: 8, height: 8, borderRadius: 4, marginRight: 8},
  statusText: {fontSize: font.tag, fontFamily: font.family, fontWeight: '600'},

  // caixa com altura fixa p/ o texto do áudio nunca empurrar/cobrir o resto
  queryBox: {
    height: 84,
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginBottom: 20,
  },
  query: {
    color: color.text,
    fontSize: font.query,
    lineHeight: font.query + 6,
    fontFamily: font.family,
    fontWeight: '700',
    textAlign: 'center',
    maxWidth: 760,
  },
  prompt: {color: color.muted, fontWeight: '600', fontSize: font.prompt},
  orbHolder: {
    width: orbT.size,
    height: orbT.size,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  hint: {
    color: color.muted,
    fontSize: font.hint,
    fontFamily: font.family,
    fontWeight: '500',
    marginTop: 20,
    textAlign: 'center',
  },
});
