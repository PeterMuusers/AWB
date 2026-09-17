// Aanraking op een Leaflet-kaart op een touchscherm:
//  - één vinger op een handvat (sleepbare marker) sleept dat handvat (Leaflet zelf);
//  - één vinger op de kaart zelf swipet de pagina's (horizontaal) of scrolt de pagina (verticaal),
//    nagebootst omdat de kaart touch-action: none heeft;
//  - twee vingers verschuiven en zoomen de kaart (Leaflet touchZoom; dragging staat uit op touch).
// Zo bedient een gebaar óf een interactief element, óf de kaart, óf de pagina, nooit twee tegelijk.

const HANDLE_SEL = '.leaflet-marker-draggable, .leaflet-marker-icon, .leaflet-control, .leaflet-interactive';
const DEAD_PX = 8;      // pas na deze verplaatsing kiezen we een richting
const FLICK_PX = 40;    // verder dan dit in de swipe-richting: naar de volgende pagina

export const coarsePointer = () => matchMedia('(pointer: coarse)').matches;

function verticalScroller(el) {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return document.scrollingElement || document.documentElement;
}

export function attachMapSwipe(el, pages = document.querySelector('.pages')) {
  if (!coarsePointer()) return;
  let start = null;
  let axis = null;
  let startLeft = 0;
  let startTop = 0;
  let scroller = null;
  let pageIndex = 0;

  const pageEls = () => (pages ? [...pages.children] : []);
  const swipeable = () => pages && pages.scrollWidth > pages.clientWidth + 1;
  const nearestIndex = () => {
    const els = pageEls();
    let best = 0;
    els.forEach((p, i) => { if (Math.abs(p.offsetLeft - pages.scrollLeft) < Math.abs(els[best].offsetLeft - pages.scrollLeft)) best = i; });
    return best;
  };
  const goTo = (i) => {
    const els = pageEls();
    const p = els[Math.max(0, Math.min(els.length - 1, i))];
    if (!p) return;
    pages.scrollTo({ left: p.offsetLeft, behavior: 'smooth' });
    const restore = () => { pages.style.scrollSnapType = ''; pages.removeEventListener('scrollend', restore); };
    pages.addEventListener('scrollend', restore);
    setTimeout(restore, 600);
  };

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest(HANDLE_SEL)) { start = null; return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    axis = null;
    startLeft = swipeable() ? pages.scrollLeft : 0;
    scroller = verticalScroller(el);
    startTop = scroller.scrollTop;
    if (swipeable()) pageIndex = nearestIndex();
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!start) return;
    if (e.touches.length !== 1) { finish(); return; }     // tweede vinger: de kaart neemt het over
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!axis) {
      if (Math.hypot(dx, dy) < DEAD_PX) return;
      axis = Math.abs(dx) > Math.abs(dy) && swipeable() ? 'x' : 'y';
      if (axis === 'x') pages.style.scrollSnapType = 'none';   // anders snapt de container tijdens het slepen
    }
    if (axis === 'x') pages.scrollLeft = startLeft - dx;
    else scroller.scrollTop = startTop - dy;
  }, { passive: true });

  function finish(e) {
    if (!start) return;
    if (axis === 'x') {
      const dx = pages.scrollLeft - startLeft;             // positief = naar rechts geswiped (volgende pagina)
      goTo(Math.abs(dx) > FLICK_PX ? pageIndex + Math.sign(dx) : pageIndex);
    }
    start = null;
    axis = null;
  }
  el.addEventListener('touchend', finish, { passive: true });
  el.addEventListener('touchcancel', finish, { passive: true });
}
