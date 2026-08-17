import { useRef, useState } from 'react';

/** Draggable before/after reveal — the full-length mirror moment.
 * `pos` is the divider position (0-100). Left of the divider shows "before",
 * right shows "in it", and the handle sits exactly under the pointer. Both
 * images are full-size absolute layers; the before layer is clipped with
 * clip-path so there is no width math and no ref-dependent first render. */
export default function BeforeAfter(props: { before: string; after: string; altAfter: string }) {
  const [pos, setPos] = useState(28);
  const ref = useRef<HTMLDivElement>(null);

  function fromPointer(clientX: number) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPos(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  }

  return (
    <div
      ref={ref}
      className="mirror-reveal relative h-full w-full touch-none select-none overflow-hidden"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        fromPointer(e.clientX);
      }}
      onPointerMove={(e) => e.buttons === 1 && fromPointer(e.clientX)}
    >
      {/* base layer: the try-on result */}
      <img src={props.after} alt={props.altAfter} className="absolute inset-0 h-full w-full object-cover" />
      {/* top layer: the original photo, clipped to the left of the divider */}
      <img
        src={props.before}
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      {/* handle at the divider */}
      <div className="absolute inset-y-0" style={{ left: `${pos}%` }} aria-hidden>
        <div className="absolute inset-y-0 -left-px w-0.5 bg-white/85 shadow-[0_0_10px_rgba(0,0,0,0.35)]" />
        <div className="absolute top-1/2 -left-3.5 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[10px] text-ink shadow-md">
          ↔
        </div>
      </div>
      <span className="tag-label absolute top-3 left-3 rounded-full bg-ink/55 px-2.5 py-1 !text-white/90">before</span>
      <span className="tag-label absolute top-3 right-3 rounded-full bg-ink/55 px-2.5 py-1 !text-white/90">in it</span>
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label="Reveal the try-on result"
        className="absolute inset-x-4 bottom-3 h-6 cursor-ew-resize opacity-0"
      />
    </div>
  );
}
