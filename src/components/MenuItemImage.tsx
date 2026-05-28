import React, { useState } from 'react';
import {
  UtensilsCrossed,
  Beef,
  Pizza,
  Coffee,
  Soup,
  Salad,
  IceCream,
  Wine,
  Sandwich,
} from 'lucide-react';

interface MenuItemImageProps {
  src?: string | null;
  alt: string;
  /** Used to deterministically pick a gradient when no image is available. Falls back to `alt`. */
  seed?: string | number | null;
  /** Category name for icon selection. Matched by keyword; defaults to UtensilsCrossed. */
  category?: string | null;
  className?: string;
  iconClassName?: string;
}

// Warm food-palette gradient pairs (Tailwind `from-…/to-…`) tuned to read on
// the existing dark surfaces. Picked deterministically by seed hash so the same
// item always renders the same swatch — visual variety across a grid without
// the "all cards identical" effect.
const GRADIENTS: ReadonlyArray<string> = [
  'from-amber-900/40 to-orange-800/30',     // tortilla / salsa roja
  'from-rose-900/40 to-red-800/30',          // beef / chipotle
  'from-yellow-900/40 to-amber-800/30',      // mustard / queso
  'from-emerald-900/40 to-teal-800/30',      // lime / herb
  'from-stone-800/50 to-amber-900/30',       // bean / mole
  'from-orange-900/40 to-rose-800/30',       // achiote / habanero
];

// Category keyword → Lucide icon. Order matters: first keyword wins.
// Keep keywords lowercase; both ES + EN tokens listed.
const CATEGORY_ICONS: ReadonlyArray<{ keywords: string[]; Icon: React.ComponentType<{ className?: string }> }> = [
  { keywords: ['pizza'], Icon: Pizza },
  { keywords: ['café', 'cafe', 'coffee', 'bebida', 'drink', 'tea', 'té'], Icon: Coffee },
  { keywords: ['cerveza', 'beer', 'wine', 'vino', 'cocktail', 'cóctel', 'liquor', 'mezcal', 'tequila'], Icon: Wine },
  { keywords: ['soup', 'sopa', 'caldo', 'broth', 'ramen'], Icon: Soup },
  { keywords: ['salad', 'ensalada', 'veggie', 'vegan', 'vegetarian'], Icon: Salad },
  { keywords: ['ice cream', 'helado', 'postre', 'dessert', 'sweet', 'pastry'], Icon: IceCream },
  { keywords: ['burger', 'hamburguesa', 'sandwich', 'sándwich', 'torta', 'wrap'], Icon: Sandwich },
  { keywords: ['burrito', 'taco', 'beef', 'carne', 'pollo', 'chicken', 'pork', 'cerdo', 'asada', 'al pastor', 'bowl'], Icon: Beef },
];

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pickGradient(seed: string): string {
  return GRADIENTS[hashString(seed) % GRADIENTS.length];
}

function pickIcon(category: string | null | undefined): React.ComponentType<{ className?: string }> {
  if (!category) return UtensilsCrossed;
  const lower = category.toLowerCase();
  for (const { keywords, Icon } of CATEGORY_ICONS) {
    if (keywords.some(k => lower.includes(k))) return Icon;
  }
  return UtensilsCrossed;
}

const MenuItemImage: React.FC<MenuItemImageProps> = ({
  src,
  alt,
  seed,
  category,
  className = 'w-full h-full object-cover',
  iconClassName = 'w-10 h-10 text-white/40',
}) => {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    const seedStr = String(seed ?? alt ?? '');
    const gradient = pickGradient(seedStr);
    const Icon = pickIcon(category);
    return (
      <div
        role="img"
        aria-label={alt}
        className={`w-full h-full bg-gradient-to-br ${gradient} flex items-center justify-center`}
      >
        <Icon className={iconClassName} />
      </div>
    );
  }

  return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />;
};

export default MenuItemImage;
