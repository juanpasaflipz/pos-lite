import React from 'react';
import { Hand } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';

const AttractScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantName } = useKioskBinding();

  return (
    <button
      onClick={() => navigate('/menu')}
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
