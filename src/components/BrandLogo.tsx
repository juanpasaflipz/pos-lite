import React from 'react';
import { useBranding } from '../context/BrandingContext';

interface BrandLogoProps {
  className?: string;
}

const BrandLogo: React.FC<BrandLogoProps> = ({ className = 'h-10' }) => {
  const { branding } = useBranding();
  const src = branding?.logoUrl || '/logo.png';
  const alt = branding?.restaurantName || 'Desktop Kitchen';

  return <img src={src} alt={alt} className={className} />;
};

export default BrandLogo;
