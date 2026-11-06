export const PERSONBOT_MODELS = [
  { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
] as const;

export interface PersonbotSetupRuntime {
  enabled: boolean;
  state: "stopped" | "starting" | "ready" | "failed" | "closing";
  workspace: string;
  provider: string;
  model: string;
  error?: string;
}

/** Credentials are write-only; the browser receives presence and source, never the stored value. */
export interface PersonbotSetup {
  primary: boolean;
  revision: number;
  provider: string;
  model: string;
  workspace: string;
  credential: {
    configured: boolean;
    source: "environment" | "saved" | "missing";
  };
  runtime: PersonbotSetupRuntime;
  restartRequired: boolean;
}

/** Legacy members may discover the App shell without access to owner model settings. */
export type PersonbotProductBootstrap = PersonbotSetup | { primary: false };

/** Omit apiKey to retain the saved credential; clearing it is an explicit, mutually exclusive action. */
export interface PersonbotSetupInput {
  commandId: string;
  expectedRevision: number;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface PersonbotSetupSaveResult {
  revision: number;
  duplicate: boolean;
  restartRequired: boolean;
}
