import React from 'react';
import { Lock, Sparkles, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';

export function WelcomeStep() {
  const { goNext } = useOnboarding();

  const features = [
    {
      icon: Lock,
      title: 'Your data never leaves your device',
    },
    {
      icon: Sparkles,
      title: 'Intelligent summaries & insights',
    },
    {
      icon: Cpu,
      title: 'Works offline, no cloud required',
    },
  ];

  return (
    <OnboardingContainer
      title="Welcome to Protocol"
      description="Record. Transcribe. Summarize. All on your device."
      step={1}
      hideProgress={true}
    >
      <div className="flex flex-col items-center space-y-6">
        {/* Divider */}
        <div className="w-16 h-px bg-af-hover" />

        {/* Features Card */}
        <div className="w-full max-w-md bg-af-panel rounded-lg border border-af-border shadow-sm p-6 space-y-4">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div key={index} className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <div className="w-5 h-5 rounded-full bg-af-panel-2 flex items-center justify-center">
                    <Icon className="w-3 h-3 text-af-text-2" />
                  </div>
                </div>
                <p className="text-sm text-af-text-2 leading-relaxed">{feature.title}</p>
              </div>
            );
          })}
        </div>

        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-3">
          <Button
            onClick={goNext}
            className="w-full h-11 bg-af-elevated hover:bg-af-elevated text-white"
          >
            Get Started
          </Button>
          <p className="text-xs text-center text-af-text-3">Takes less than 3 minutes</p>
        </div>
      </div>
    </OnboardingContainer>
  );
}
