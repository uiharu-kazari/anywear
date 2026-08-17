import { useId, useRef } from 'react';
import { fileToDataURL } from '../lib/image';

export default function PhotoSlot(props: {
  label: string;
  hint: string;
  photo: string | null;
  onPhoto: (dataUrl: string) => void;
  tall?: boolean;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="tag-label cursor-pointer">
        {props.label}
      </label>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={`group relative overflow-hidden rounded-2xl border border-line bg-paper transition hover:border-sage ${
          props.tall ? 'aspect-[3/4]' : 'aspect-square'
        } w-full`}
      >
        {props.photo ? (
          <>
            <img src={props.photo} alt={props.label} className="h-full w-full object-cover" />
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
        accept="image/jpeg,image/png"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) props.onPhoto(await fileToDataURL(file));
          e.target.value = '';
        }}
      />
    </div>
  );
}
