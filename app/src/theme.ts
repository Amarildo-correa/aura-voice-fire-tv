// Design tokens — tela de busca por voz "Aura".
// Canvas logico do device = 960x540 (nao 1920x1080): tamanhos dimensionados
// para 540 de altura. Assinatura: orb que respira com o nivel real da voz.

export const color = {
  bg: '#0F1115',
  bgElev: '#141821',
  surface: '#171A20',
  surfaceFocus: '#20242D',
  hairline: '#262B33',
  text: '#F3F5F8',
  muted: '#7C8390',
  faint: '#4A515C',
  accent: '#FFB020', // ambar (assinatura / foco / repouso)
  live: '#36E2A0', // menta (apenas voz ao vivo)
  danger: '#FF6B6B',
};

export const font = {
  family: 'Amazon Ember',
  prompt: 24,
  query: 30,
  title: 19,
  chip: 17,
  hint: 17,
  tag: 13,
};

export const space = {
  safeX: 52,
  safeY: 30,
};

export const focus = {
  scale: 1.06,
  dur: 150,
};

export const orb = {
  size: 150, // lado do orb em px (canvas 540)
  ringDur: 1400,
};
