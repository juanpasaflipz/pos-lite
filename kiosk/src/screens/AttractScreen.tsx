import React, { useEffect, useRef } from 'react';
import { Hand } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useKioskCart } from '../context/KioskCartContext';

const AttractScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantName } = useKioskBinding();
  const { clearSession } = useKioskCustomer();
  const { clearCart } = useKioskCart();

  // The attract screen is the start of every order — reset any leftover
  // customer session or cart from a previous, abandoned interaction.
  useEffect(() => {
    clearSession();
    clearCart();
  }, [clearSession, clearCart]);

  // Hidden admin gesture: 5 taps in the top-right corner within 3 seconds opens
  // device settings (terminal pairing). Customer-facing taps still go to /home.
  const tapsRef = useRef<number[]>([]);
  const onAdminTap = (e: React.MouseEvent) => {
    e.stopPropagation();
    const now = Date.now();
    tapsRef.current = [...tapsRef.current.filter((t) => now - t < 3000), now];
    if (tapsRef.current.length >= 5) {
      tapsRef.current = [];
      navigate('/terminal-settings');
    }
  };

  return (
    <div className="relative h-full w-full">
      <button
        onClick={() => navigate('/fulfillment')}
        className="h-full w-full bg-brand-700 flex flex-col items-center justify-center text-white touch-manipulation px-8"
      >
        {tenantName && (
          <div className="text-2xl text-white/75 mb-4 uppercase tracking-widest font-black">
            {tenantName}
          </div>
        )}
        <div className="text-[96px] font-black tracking-tight mb-6 text-center leading-none">
          Ordena aqui
        </div>
        <div className="text-4xl font-black text-white/85 mb-16">Toca para empezar</div>
        <div className="w-36 h-36 rounded-full border-4 border-white/45 flex items-center justify-center motion-safe:animate-pulse">
          <Hand className="h-20 w-20" />
        </div>
      </button>
      <button
        type="button"
        aria-label="Admin"
        onClick={onAdminTap}
        className="absolute top-0 right-0 w-48 h-48 flex items-start justify-end p-3"
      >
        <span className="block w-2 h-2 rounded-full bg-white/30" aria-hidden="true" />
      </button>
    </div>
  );
};

export default AttractScreen;
