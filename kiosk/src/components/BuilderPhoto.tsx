// Photo band for the wizard's big decision cards (favoritos, proteins, estilo,
// sides/drinks). Modeled on the POS MenuItemImage: real photo when there is
// one, and a deterministic warm gradient + the card's existing BuilderIcon
// glyph when there isn't — so an unphotographed item still looks intentional,
// never like a broken image. Small chips and list rows keep bare BuilderIcons;
// this component is only for card-scale imagery.
import React, { useState } from 'react';
import { BuilderIcon, type BuilderIconName } from '../lib/builderIcons';

// Warm food-palette gradient pairs, readable on the dark kiosk surfaces.
// Deterministic by seed so a given card always wears the same swatch.
const GRADIENTS: ReadonlyArray<string> = [
  'from-amber-900/40 to-orange-800/30',
  'from-rose-900/40 to-red-800/30',
  'from-yellow-900/40 to-amber-800/30',
  'from-stone-800/50 to-amber-900/30',
  'from-orange-900/40 to-rose-800/30',
];

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

interface BuilderPhotoProps {
  src: string | null | undefined;
  alt: string;
  /** Glyph shown on the gradient fallback — pass the card's current icon. */
  fallbackIcon: BuilderIconName;
  /** Applied to the band wrapper; defaults to the shared 4:3 card band. */
  className?: string;
  iconClassName?: string;
}

const BuilderPhoto: React.FC<BuilderPhotoProps> = ({
  src,
  alt,
  fallbackIcon,
  className = 'aspect-[4/3] w-full',
  iconClassName = 'h-[clamp(34px,6vw,48px)] w-[clamp(34px,6vw,48px)]',
}) => {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    const gradient = GRADIENTS[hashString(alt) % GRADIENTS.length];
    return (
      <div
        role="img"
        aria-label={alt}
        className={`${className} bg-gradient-to-br ${gradient} flex items-center justify-center overflow-hidden flex-shrink-0`}
      >
        <BuilderIcon name={fallbackIcon} className={`${iconClassName} text-brand-300`} />
      </div>
    );
  }

  return (
    <div className={`${className} bg-neutral-800 overflow-hidden flex-shrink-0`}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  );
};

export default BuilderPhoto;
