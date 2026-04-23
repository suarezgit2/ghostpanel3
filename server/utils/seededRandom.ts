/**
 * Seeded Random Number Generator
 * 
 * Usado para gerar valores determinísticos baseado em uma seed.
 * Garante que os mesmos valores são gerados para a mesma seed.
 * 
 * Exemplo:
 *   const rng = seededRng("clientId123");
 *   const battery = rng(); // 0.67
 *   const fonts = Math.floor(rng() * 31) + 50; // 62
 */

export function seededRng(seed: string): () => number {
  // Converter seed em número
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  // Usar hash como seed para Mulberry32 (algoritmo simples de PRNG)
  let state = Math.abs(hash) || 1;
  
  return function() {
    // Mulberry32 algorithm
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Gerar battery de forma determinística
 */
export function generateBatteryDeterministic(seed: string) {
  const rng = seededRng(seed);
  
  return {
    charging: rng() > 0.5,
    chargingTime: rng() > 0.7 ? 0 : null,
    dischargingTime: null,
    level: Math.round((rng() * 0.7 + 0.2) * 100) / 100, // 0.2 - 0.9
  };
}

/**
 * Gerar fontsCount de forma determinística
 */
export function generateFontsCountDeterministic(seed: string): number {
  const rng = seededRng(seed);
  return Math.floor(rng() * 31) + 50; // 50-80
}

/**
 * Gerar maxTouchPoints de forma determinística
 */
export function generateMaxTouchPointsDeterministic(seed: string): number {
  const rng = seededRng(seed);
  const random = rng();
  
  if (random < 0.3) return 0;      // 30% - sem touch
  if (random < 0.7) return 10;     // 40% - 10 pontos
  return 20;                        // 30% - 20 pontos
}

/**
 * Gerar devicePixelRatio de forma determinística
 */
export function generateDevicePixelRatioDeterministic(seed: string): number {
  const rng = seededRng(seed);
  const random = rng();
  
  if (random < 0.7) return 1;      // 70% - 1x
  if (random < 0.9) return 1.5;    // 20% - 1.5x (tablets)
  return 2;                         // 10% - 2x (high DPI)
}

/**
 * Gerar colorDepth de forma determinística
 */
export function generateColorDepthDeterministic(seed: string): number {
  const rng = seededRng(seed);
  const random = rng();
  
  if (random < 0.95) return 24;    // 95% - 24 bits (padrão)
  return 32;                        // 5% - 32 bits
}
