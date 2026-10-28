// Red string between pins stuck on a row of photos.
//
// The board's own strings live behind all paper, so they cannot cross a sheet. This is a
// small overlay for one pane instead: the parent registers one anchor element per photo
// (where the pin goes), this component measures the anchors against the container and
// draws a sagging string from each pin to the next, then the pin heads on top so every
// string ends exactly under a pin. It re-measures on resize, font and image loads.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

function same(a, b) {
  return (
    a.length === b.length &&
    a.every((p, i) => p.id === b[i].id && Math.abs(p.x - b[i].x) < 0.5 && Math.abs(p.y - b[i].y) < 0.5)
  );
}

export function PinStrings({ containerRef, anchorsRef, ids, sag = 12 }) {
  const [pts, setPts] = useState([]);
  const raf = useRef(0);
  const key = ids.join("|");

  const measure = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const box = containerRef.current;
      if (!box) return;
      const b = box.getBoundingClientRect();
      const next = [];
      for (const id of ids) {
        const el = anchorsRef.current.get(id);
        if (!el || !el.isConnected) continue;
        const r = el.getBoundingClientRect();
        next.push({ id, x: r.left + r.width / 2 - b.left, y: r.top + r.height / 2 - b.top });
      }
      setPts((prev) => (same(prev, next) ? prev : next));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, anchorsRef, key]);

  useLayoutEffect(() => {
    measure();
    // entrance animations of the pane settle a moment later
    const t = setTimeout(measure, 400);
    return () => clearTimeout(t);
  }, [measure]);

  useEffect(() => {
    const box = containerRef.current;
    if (!box) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    const onLoad = (e) => e.target instanceof HTMLImageElement && measure();
    box.addEventListener("load", onLoad, true);
    window.addEventListener("resize", measure);
    document.fonts?.ready?.then(measure);
    return () => {
      cancelAnimationFrame(raf.current);
      ro.disconnect();
      box.removeEventListener("load", onLoad, true);
      window.removeEventListener("resize", measure);
    };
  }, [containerRef, measure]);

  return (
    <div className="pin-strings" aria-hidden="true">
      <svg>
        {pts.slice(1).map((B, i) => {
          const A = pts[i];
          const len = Math.hypot(B.x - A.x, B.y - A.y);
          const dip = Math.min(sag, len * 0.06);
          const d = `M${A.x.toFixed(1)} ${A.y.toFixed(1)} Q${((A.x + B.x) / 2).toFixed(1)} ${((A.y + B.y) / 2 + dip).toFixed(1)} ${B.x.toFixed(1)} ${B.y.toFixed(1)}`;
          // keyed by the pair so a new page of photos draws its strings in again
          return <path key={`${A.id}-${B.id}`} d={d} pathLength="1" style={{ animationDelay: `${0.25 + i * 0.3}s` }} />;
        })}
      </svg>
      {pts.map((p, i) => (
        <span
          key={p.id}
          className="pin pin-red pin-strings-head"
          style={{ transform: `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`, animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </div>
  );
}
