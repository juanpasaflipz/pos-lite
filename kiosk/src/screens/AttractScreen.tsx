import React, { useEffect } from 'react';
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

  return (
    <button
      onClick={() => navigate('/welcome')}
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
  );
};

export default AttractScreen;
