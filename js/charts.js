/* ============================================================
   Chart helpers — neutral sequential palette.
   No political color encoding by design.
   ============================================================ */

const ChartHelpers = (() => {
  const PALETTE = [
    '#059669', // emerald
    '#2563eb', // blue
    '#7c3aed', // violet
    '#ea580c', // orange
    '#0891b2', // cyan
    '#db2777', // pink
    '#65a30d', // lime
    '#9333ea', // purple
    '#c2410c', // rust
    '#0d9488', // teal
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
