export interface TUIOptions {
  config: import('../types/index.js').AppConfig;
  initialPrompt?: string;
  model?: string;
  provider?: string;
  mode?: 'plan' | 'build' | 'review';
  nonInteractive: boolean;
}

export function startTUI(options: TUIOptions): Promise<void>;
