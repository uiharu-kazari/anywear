import { useId, useRef } from 'react';
import { useStore } from '../lib/store';

export default function PhotoSlot(props: {
  label: string;
  hint: string;
  photo: string | null;
  onPhoto: (dataUrl: string) => void;
}) {
  const id = useId();
  const readImage = useStore((s) => s.readImage);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="tag-label cursor-pointer">
        {props.label}
      </label>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="group relative aspect-[3/4] w-full overflow-hidden rounded-2xl border border-line bg-paper transition hover:border-sage"
      >
        {props.photo ? (
          <>
            <img src={props.photo} alt={props.label} className="h-full w-full object-contain" />
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/60 to-transparent px-3 pt-8 pb-2 text-left text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
              Replace photo
            </span>
          </>
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-lg text-ink-soft">
              +
            </span>
            <span className="text-xs leading-relaxed text-ink-soft">{props.hint}</span>
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={async (e) => {
          const dataUrl = await readImage(e.target.files?.[0]);
          e.target.value = '';
          if (dataUrl) props.onPhoto(dataUrl);
        }}
      />
    </div>
  );
}
