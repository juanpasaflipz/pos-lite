import React from 'react';

interface Props {
  count?: number;
  withImages?: boolean;
}

const MenuGridSkeleton: React.FC<Props> = ({ count = 8, withImages = true }) => {
  return (
    <div className="grid grid-cols-2 gap-2 px-3 pb-4" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="bg-neutral-800 rounded-xl p-3 flex flex-col justify-between min-h-[88px] motion-safe:animate-pulse"
        >
          {withImages && <div className="w-full h-20 rounded-lg mb-2 bg-neutral-700" />}
          <div className="flex-1 space-y-1.5">
            <div className="h-3 rounded bg-neutral-700 w-3/4" />
            <div className="h-3 rounded bg-neutral-700 w-1/2" />
          </div>
          <div className="flex items-center justify-between mt-2">
            <div className="h-3 rounded bg-neutral-700 w-12" />
          </div>
        </div>
      ))}
    </div>
  );
};

export default React.memo(MenuGridSkeleton);
