/** Archived conversations are read-only source material, not native dsh context or transferable permissions. */
export interface PersonbotLegacyThread {
  id: string;
  title: string;
  botName: string;
  updatedAt?: number;
}

export interface PersonbotLegacyList {
  threads: PersonbotLegacyThread[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface PersonbotLegacyMessage {
  id: string;
  role: "user" | "assistant" | "notice";
  kind: string;
  text: string;
  createdAt: number;
  truncated?: boolean;
  attachments?: Array<{ name: string; kind: string }>;
}

export interface PersonbotLegacyDetail {
  thread: PersonbotLegacyThread;
  messages: PersonbotLegacyMessage[];
  hasMore: boolean;
  nextCursor?: string;
  configuration: {
    roleName: string;
    instructions: string;
    workspace?: string;
  };
}

/** An explicit import creates one new conversation and submits the owner-confirmed goal and progress once. */
export interface PersonbotLegacyImport {
  commandId: string;
  goal: string;
  progress: string;
  importConfiguration: boolean;
}

export interface PersonbotLegacyImportResult {
  sessionId: string;
  threadId: string;
  createdAt: string;
  configurationImported: boolean;
  projectId?: string;
  roleId?: string;
}
