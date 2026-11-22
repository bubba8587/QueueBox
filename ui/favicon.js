// The tab's [Q] mark, drawn in Allo's heaviest weight and the page's accent, and redrawn when the accent or the
// theme changes. Until Allo loads, index.html's static mark stands in.

const SIZE = 64;

export function startFavicon() {
  const link = document.getElementById('favicon');
  if (!link) return;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d');
  let last = '';
  const draw = () => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (!accent || accent === last) return;
    last = accent;
    g.clearRect(0, 0, SIZE, SIZE);
    g.fillStyle = accent;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    // The widest size whose [Q] still fits the square.
    let px = 46;
    g.font = `900 ${px}px Allo, system-ui, sans-serif`;
    while (px > 20 && g.measureText('[Q]').width > SIZE - 2) g.font = `900 ${--px}px Allo, system-ui, sans-serif`;
    g.fillText('[Q]', SIZE / 2, SIZE / 2 + px * 0.36);
    link.href = canvas.toDataURL('image/png');
  };
  document.fonts.load('900 46px Allo').then(() => {
    last = '';
    draw();
  }, draw);
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
  draw();
}
