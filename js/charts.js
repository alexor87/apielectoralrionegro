/* ============================================================
   Chart helpers — neutral sequential palette.
   No political color encoding by design.
   ============================================================ */

const ChartHelpers = (() => {
  const PALETTE = [
    '#1d9e75', // green principal
    '#185fa5', // azul acento
    '#6e4f9f', // morado neutro
    '#b86b3a', // ámbar
    '#2c8189', // teal
    '#8a7a2a', // mostaza
    '#6a4f6f', // ciruela
    '#466d2e', // verde oscuro
    '#a14f5f', // borgoña
    '#5c6f8a', // azul gris
  ];

  /** Get a stable color from the palette by index. */
  function color(index) {
    return PALETTE[index % PALETTE.length];
  }

  /** Format an integer with thousand separators (es-CO style). */
  function formatNumber(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('es-CO');
  }

  /** Format a percentage to one decimal place. */
  function formatPct(n) {
    if (n == null || isNaN(n)) return '—';
    return `${Number(n).toFixed(1)}%`;
  }

  /** Compute % share against the maximum value in a list (for bar widths). */
  function pctOfMax(value, max) {
    if (!max) return 0;
    return Math.max(0, Math.min(100, (value / max) * 100));
  }

  /** Compute % share against a total (for percentage display). */
  function pctOfTotal(value, total) {
    if (!total) return 0;
    return (value / total) * 100;
  }

  return { PALETTE, color, formatNumber, formatPct, pctOfMax, pctOfTotal };
})();
