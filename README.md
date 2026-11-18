# Aura — busca por voz no Fire TV Stick (Vega OS)

Prova de conceito que captura o **microfone do controle Bluetooth** do Fire TV Stick (Vega OS) em um app **React Native for Vega nativo** de terceiro, transcreve a fala (STT) e escreve o texto no próprio campo do app — sem o teclado do sistema.

A tela imita a experiência nativa da Alexa: o app fica escutando e, **enquanto o botão de voz do controle estiver pressionado, grava sem cortar** (só finaliza quando o controle para de transmitir, ou seja, quando o botão é solto).

## Estrutura

- `app/` — app React Native for Vega (RN 0.83). Tela em `app/src/App.tsx`, orb de microfone em SVG em `app/src/components/MicOrb.tsx`, tokens de design em `app/src/theme.ts`.
- `server/stt_server.py` — relay de STT local (roda no PC): recebe o WAV do app, apara o silêncio, normaliza capturas fracas, transcreve no **Deepgram** (nova-2 pt) com fallback para **faster-whisper** local, e expõe `/back` (injeta `KEY_BACK` no device via `vda`, só em dev).
- `docs/mockups/` — mockups do resultado esperado.

## Como a captura funciona

O Fire TV Stick não tem microfone embutido. O único mic é o do controle Bluetooth, que **só transmite áudio enquanto o botão de voz está pressionado**. Um `AudioRecordStream` aberto (privilégio `com.amazon.audio.privilege.microphone.access`) recebe esse áudio em paralelo à Alexa. O app detecta início/fim da transmissão por nível e monta um WAV 16 kHz mono PCM16.

## Build e deploy (dev)

Pré-requisitos: Vega SDK (container Docker no WSL), Fire TV Stick em modo desenvolvedor conectado por `vda`. Veja a skill `vega-os-windows`.

```
cd app
npm install --legacy-peer-deps
npm run build:release          # gera build/armv7-release/*.vpkg
# instalar o .vpkg armv7 no Stick via vda / vega device install-app
```

Relay de STT (no PC):

```
export DEEPGRAM_API_KEY=<sua-chave>     # ou crie um arquivo .dg.env (ignorado pelo git)
python3 server/stt_server.py 8899
```

O app aponta para o relay em `app/src/App.tsx` (`RELAY = http://<ip-do-pc>:8899`). Em produção, troque por um endpoint de STT na nuvem (HTTPS).

## Limitações em produção (Appstore)

- A **captura** pode funcionar (o privilégio de mic é concedível a terceiro), mas usar o mic do botão Alexa é **comportamento não-documentado** e pode ser reprovado na revisão ou quebrar em updates.
- **Cortar o overlay da Alexa não funciona em produção**: a injeção de `KEY_BACK` exige assinatura de plataforma (feita aqui via `vda`, só em dev). O overlay da Alexa aparecerá.
- Caminho robusto para produção: celular como microfone, ou o ditado do teclado do sistema.
