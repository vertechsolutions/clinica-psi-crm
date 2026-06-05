'use client';
import { useState } from 'react';

export function Avatar({
  src,
  iniciais,
  cor,
  size = 36,
  ring = true,
}: {
  src?: string;
  iniciais: string;
  cor: string;
  size?: number;
  ring?: boolean;
}) {
  const [err, setErr] = useState(false);
  const dim = { width: size, height: size };

  if (!src || err) {
    return (
      <div
        style={{ ...dim, background: cor }}
        className={`flex shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
          ring ? 'ring-2 ring-white' : ''
        }`}
      >
        {iniciais}
      </div>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt={iniciais}
      loading="lazy"
      onError={() => setErr(true)}
      style={dim}
      className={`shrink-0 rounded-full object-cover ${ring ? 'ring-2 ring-white' : ''}`}
    />
  );
}
