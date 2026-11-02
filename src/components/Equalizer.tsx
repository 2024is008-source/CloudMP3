// Decorative animated equalizer behind the home hero. Deterministic values keep SSR and hydration identical.
const BARS = Array.from({ length: 56 }, (_, i) => {
  const h = 35 + ((i * 37) % 60);
  const dur = 1.1 + ((i * 13) % 9) / 10;
  const delay = -((i * 7) % 17) / 10;
  return { h, dur, delay };
});

export function Equalizer() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px] overflow-hidden">
      <div className="hero-glow absolute inset-0" />
      <div className="absolute inset-x-0 bottom-0 flex h-56 items-end justify-center gap-[6px] px-4 opacity-45 [mask-image:linear-gradient(to_top,transparent,black_40%)]">
        {BARS.map((b, i) => (
          <span
            key={i}
            className="eq-bar w-2 shrink-0 md:w-2.5"
            style={{ height: `${b.h}%`, ["--eq-dur" as string]: `${b.dur}s`, ["--eq-delay" as string]: `${b.delay}s` }}
          />
        ))}
      </div>
    </div>
  );
}
