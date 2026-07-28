import type React from 'react';
import type { ProcessingStep } from '../types';
import { useTranslation } from 'react-i18next';

interface StreamingProgressProps {
    steps: ProcessingStep[];
    isComplete: boolean;
}

export const StreamingProgress: React.FC<StreamingProgressProps> = ({ steps, isComplete }) => {
    const { t, i18n } = useTranslation();
    return (
        <div className="streaming-progress">
            <div className="progress-header">
                <span>{t('progress.processingMessage')}</span>
                {isComplete && <span className="complete">✓ {t('progress.complete')}</span>}
            </div>
            
            <div className="steps-container">
                {steps.map((step) => (
                    <div key={step.id} className={`step step-${step.status}`}>
                        <div className="step-icon">
                            {step.status === 'completed' && '✓'}
                            {step.status === 'error' && '✗'}
                            {step.status === 'in_progress' && '⟳'}
                            {step.status === 'pending' && '○'}
                        </div>
                        <div className="step-content">
                            <div className="step-name">{step.name}</div>
                            <div className="step-message">{step.message}</div>
                            {step.data && (
                                <div className="step-data">
                                    {JSON.stringify(step.data, null, 2)}
                                </div>
                            )}
                            {step.error && (
                                <div className="step-error">{step.error}</div>
                            )}
                        </div>
                        <div className="step-timestamp">
                            {new Date(step.timestamp).toLocaleTimeString(i18n.language)}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}; 
