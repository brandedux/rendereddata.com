// Mobile bottom sheet for the map tools (playground, SDK demo).
//
// On phones the map fills the screen and the control panel becomes a sheet that drags up from the
// bottom and collapses to a handle, so the map stays primary. On desktop this is a no-op: the
// original two-column grid is untouched (the handle is hidden, the scroll wrapper is display:contents).
//
//   import {initBottomSheet} from './sheet.js';
//   initBottomSheet(document.getElementById('side'));   // #side is the control <aside>
//
// The matching CSS lives in each page under a `@media (max-width: 760px)` block and keys off the
// classes added here: .gv-sheet on the panel, .gv-sheet-handle (the grab bar), .gv-sheet-scroll
// (the scrolling content), plus .expanded / .dragging state classes.

export function initBottomSheet(side, opts = {}) {
    if (!side || side.dataset.sheet) return null;     // guard against double init
    side.dataset.sheet = '1';
    const peek = opts.peek ?? 84;
    const mq = window.matchMedia(`(max-width: ${opts.breakpoint ?? 760}px)`);

    // Restructure once: move the panel's children into a scroll wrapper and prepend a grab handle.
    const scroll = document.createElement('div');
    scroll.className = 'gv-sheet-scroll';
    while (side.firstChild) scroll.appendChild(side.firstChild);
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'gv-sheet-handle';
    handle.setAttribute('aria-label', 'Show or hide the controls');
    handle.innerHTML = '<span class="gv-sheet-grip"></span><span class="gv-sheet-hint">Controls</span>';
    side.append(handle, scroll);
    side.classList.add('gv-sheet');
    side.style.setProperty('--sheet-peek', peek + 'px');

    let expanded = false;
    const setExpanded = (v) => {
        expanded = v;
        side.classList.toggle('expanded', v);
        handle.setAttribute('aria-expanded', String(v));
        handle.querySelector('.gv-sheet-hint').textContent = v ? 'Close' : 'Controls';
    };

    const expandedH = () => Math.round(window.innerHeight * 0.85);
    let dragging = false, moved = false, startY = 0, startH = 0;

    handle.addEventListener('pointerdown', (e) => {
        if (!mq.matches) return;
        dragging = true; moved = false; startY = e.clientY;
        startH = side.getBoundingClientRect().height;
        side.classList.add('dragging');
        try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dy = e.clientY - startY;
        if (Math.abs(dy) > 5) moved = true;
        const h = Math.max(peek, Math.min(expandedH(), startH - dy));
        side.style.height = h + 'px';
    });
    const end = () => {
        if (!dragging) return;
        dragging = false;
        side.classList.remove('dragging');
        const h = side.getBoundingClientRect().height;
        side.style.height = '';                        // hand control back to the CSS classes
        if (!moved) setExpanded(!expanded);            // a tap toggles
        else setExpanded(h > (peek + expandedH()) / 2);// a drag snaps to the nearer state
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);

    const sync = () => { if (!mq.matches) side.style.height = ''; else setExpanded(expanded); };
    mq.addEventListener('change', sync);
    sync();

    return {expand: () => setExpanded(true), collapse: () => setExpanded(false), isExpanded: () => expanded};
}
