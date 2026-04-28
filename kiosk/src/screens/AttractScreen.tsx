import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';

const AttractScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantName } = useKioskBinding();

  return (
    <button
      onClick={() => navigate('/menu')}
      className="h-full w-full bg-gradient-to-br from-brand-700 via-brand-600 to-brand-800 flex flex-col items-center justify-center text-white touch-manipulation"
    >
      {tenantName && (
        <div className="text-xl text-white/70 mb-2 uppercase tracking-widest font-semibold">
          {tenantName}
        </div>
      )}
      <div className="text-7xl md:text-8xl font-black tracking-tight mb-6 text-center px-8">
        Order Here
      </div>
      <div className="text-2xl md:text-3xl text-white/80 mb-12">Tap anywhere to start</div>
      <div className="w-28 h-28 rounded-full border-4 border-white/40 flex items-center justify-center motion-safe:animate-pulse">
        <span className="text-6xl">👆</span>
      </div>
    </button>
  );
};

export default AttractScreen;
