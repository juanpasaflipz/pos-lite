import React, { useState } from 'react';
import { UtensilsCrossed } from 'lucide-react';

interface MenuItemImageProps {
  src?: string | null;
  alt: string;
  className?: string;
  iconClassName?: string;
}

const MenuItemImage: React.FC<MenuItemImageProps> = ({
  src,
  alt,
  className = 'w-full h-full object-cover',
  iconClassName = 'w-8 h-8 text-neutral-600',
}) => {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return <UtensilsCrossed className={iconClassName} />;
  }

  return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />;
};

export default MenuItemImage;
