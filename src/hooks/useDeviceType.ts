import { useState, useEffect } from 'react';

interface DeviceType {
  deviceType: 'phone' | 'tablet' | 'desktop';
  isPortrait: boolean;
  isMobile: boolean;
  isTablet: boolean;
}

const PHONE_MAX = 767;
const TABLET_MAX = 1023;

function getDeviceType(width: number): 'phone' | 'tablet' | 'desktop' {
  if (width <= PHONE_MAX) return 'phone';
  if (width <= TABLET_MAX) return 'tablet';
  return 'desktop';
}

export function useDeviceType(): DeviceType {
  const [deviceType, setDeviceType] = useState<'phone' | 'tablet' | 'desktop'>(() =>
    getDeviceType(window.innerWidth)
  );
  const [isPortrait, setIsPortrait] = useState(() =>
    window.matchMedia('(orientation: portrait)').matches
  );

  useEffect(() => {
    const phoneQuery = window.matchMedia(`(max-width: ${PHONE_MAX}px)`);
    const tabletQuery = window.matchMedia(`(min-width: ${PHONE_MAX + 1}px) and (max-width: ${TABLET_MAX}px)`);
    const orientationQuery = window.matchMedia('(orientation: portrait)');

    const updateDevice = () => {
      if (phoneQuery.matches) {
        setDeviceType('phone');
      } else if (tabletQuery.matches) {
        setDeviceType('tablet');
      } else {
        setDeviceType('desktop');
      }
    };

    const updateOrientation = (e: MediaQueryListEvent) => {
      setIsPortrait(e.matches);
    };

    phoneQuery.addEventListener('change', updateDevice);
    tabletQuery.addEventListener('change', updateDevice);
    orientationQuery.addEventListener('change', updateOrientation);

    return () => {
      phoneQuery.removeEventListener('change', updateDevice);
      tabletQuery.removeEventListener('change', updateDevice);
      orientationQuery.removeEventListener('change', updateOrientation);
    };
  }, []);

  return {
    deviceType,
    isPortrait,
    isMobile: deviceType === 'phone',
    isTablet: deviceType === 'tablet',
  };
}
