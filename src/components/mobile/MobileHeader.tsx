import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

interface MobileHeaderProps {
  title: string;
  showBack?: boolean;
  backTo?: string;
  rightAction?: React.ReactNode;
}

const MobileHeader: React.FC<MobileHeaderProps> = ({ title, showBack, backTo, rightAction }) => {
  const navigate = useNavigate();

  return (
    <header
      className="h-14 bg-neutral-900 border-b border-neutral-800 flex items-center px-4 sticky top-0 z-10"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      {showBack && (
        <button
          onClick={() => backTo ? navigate(backTo) : navigate(-1)}
          className="mr-3 p-1 text-neutral-400 hover:text-white transition-colors touch-manipulation"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
      )}
      <h1 className="text-lg font-bold text-white flex-1">{title}</h1>
      {rightAction && <div>{rightAction}</div>}
    </header>
  );
};

export default MobileHeader;
