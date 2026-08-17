import { useStore } from '../lib/store';
import { fileToDataURL } from '../lib/image';

export default function TwinPanel() {
  const { twinPhoto, setTwin } = useStore();
  return (
    <section className="rounded-2xl border border-line bg-paper p-4">
      <h2 className="tag-label mb-3">Your twin</h2>
      <label className="group relative block cursor-pointer overflow-hidden rounded-xl">
        {twinPhoto && <img src={twinPhoto} alt="Your full-body photo" className="aspect-[3/4] w-full object-cover" />}
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/60 to-transparent px-3 pt-8 pb-2 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
          Replace photo
        </span>
        <input
          type="file"
          accept="image/jpeg,image/png"
          className="sr-only"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await setTwin(await fileToDataURL(f));
            e.target.value = '';
          }}
        />
      </label>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">
        Every look is tried on this photo. Front-facing and full-length works best.
      </p>
    </section>
  );
}
