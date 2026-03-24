import React, { ReactNode } from 'react';
import { usePlan } from '../context/PlanContext';
import UpgradePrompt from './UpgradePrompt';

interface FeatureGateProps {
  feature: 'printers' | 'delivery' | 'permissions' | 'loyalty' | 'prepForecast' | 'banking' | 'bankReconciliation' | 'dataExport' | 'cfdi' | 'ai';
  featureLabel?: string;
  children: ReactNode;
}

const FeatureGate: React.FC<FeatureGateProps> = ({ feature, featureLabel, children }) => {
  const { isFeatureLocked } = usePlan();

  if (isFeatureLocked(feature)) {
    return (
      <div className="relative min-h-[300px]">
        {children}
        <UpgradePrompt variant="overlay" feature={featureLabel || feature} />
      </div>
    );
  }

  return <>{children}</>;
};

export default FeatureGate;
