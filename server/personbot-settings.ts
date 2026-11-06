import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  PERSONBOT_MODELS,
  type PersonbotSetup,
  type PersonbotSetupInput,
  type PersonbotSetupRuntime,
} from "../shared/personbot-product.ts";
import { writeFileAtomic } from "./atomic.ts";

interface SettingsCommand {
  id: string;
  digest: string;
  revision: number;
}

interface SavedSettings {
  schema: 1;
  revision: number;
  model?: string;
  apiKey?: string;
  commands: SettingsCommand[];
}

export interface PersonbotSettingsOptions {
  home: string;
  workspace: string;
  provider?: string;
  model?: string;
  fixture?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PersonbotLaunchSettings {
  provider: string;
  model: string;
  env: NodeJS.ProcessEnv;
}

const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_COMMANDS = 1024;
const MODELS = new Set<string>(PERSONBOT_MODELS.map(model => model.id));
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class PersonbotSettingsError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PersonbotSettingsError";
    this.status = status;
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function usableKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

function parseInput(input: unknown): PersonbotSetupInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PersonbotSettingsError(400, "Expected model settings");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["commandId", "expectedRevision", "model", "apiKey", "clearApiKey"].includes(key))
    || typeof value.commandId !== "string" || !ID.test(value.commandId)
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0
    || typeof value.model !== "string"
    || value.apiKey !== undefined && !usableKey(value.apiKey)
    || value.clearApiKey !== undefined && typeof value.clearApiKey !== "boolean"
    || value.apiKey !== undefined && value.clearApiKey === true) {
    throw new PersonbotSettingsError(400, "Invalid model settings; use a supported model and an API key with 16–4096 non-space ASCII characters");
  }
  return value as unknown as PersonbotSetupInput;
}

/** Saved settings are private to this Personbot home and never read the legacy engine credential store. */
export class PersonbotSettings {
  private readonly options: PersonbotSettingsOptions;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly file: string;
  private saved: SavedSettings;
  private appliedFingerprint: string | undefined;

  constructor(options: PersonbotSettingsOptions) {
    if (!isAbsolute(options.home) || !isAbsolute(options.workspace)) {
      throw new TypeError("Personbot home and workspace must be absolute paths");
    }
    this.options = options;
    this.environment = options.env ?? process.env;
    const directory = join(options.home, "runtime");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "settings.json");
    this.saved = this.read();
  }

  launch(): PersonbotLaunchSettings {
    return {
      provider: this.options.provider ?? "deepseek-official",
      model: this.options.fixture ? this.options.model ?? "fixture" : this.saved.model ?? this.options.model ?? "deepseek-flash",
      env: { DEEPSEEK_API_KEY: this.environment.DEEPSEEK_API_KEY?.trim() || this.saved.apiKey || "" },
    };
  }

  applied(configuration: PersonbotLaunchSettings = this.launch()): void {
    this.appliedFingerprint = hash([configuration.provider, configuration.model, configuration.env.DEEPSEEK_API_KEY]);
  }

  snapshot(options: { primary: boolean; runtime: PersonbotSetupRuntime }): PersonbotSetup {
    const configuration = this.launch();
    const source = this.options.fixture || this.environment.DEEPSEEK_API_KEY?.trim() ? "environment" : this.saved.apiKey ? "saved" : "missing";
    return {
      primary: options.primary,
      revision: this.saved.revision,
      provider: configuration.provider,
      model: configuration.model,
      workspace: this.options.workspace,
      credential: { configured: source !== "missing", source },
      runtime: options.runtime,
      restartRequired: Boolean(
        this.appliedFingerprint && this.appliedFingerprint !== this.fingerprint()
        && ["starting", "ready"].includes(options.runtime.state),
      ),
    };
  }

  save(raw: unknown): { revision: number; duplicate: boolean } {
    const input = parseInput(raw);
    if (!(this.options.fixture && input.model === (this.options.model ?? "fixture")) && !MODELS.has(input.model)) {
      throw new PersonbotSettingsError(400, "Choose a model offered by the pinned DeepSeek runtime");
    }
    if (!this.options.fixture && (this.options.provider ?? "deepseek-official") !== "deepseek-official") {
      throw new PersonbotSettingsError(409, "This provider is managed by the server environment");
    }
    const digest = hash([
      input.expectedRevision, input.model, input.apiKey ?? null, input.clearApiKey === true,
    ]);
    const existing = this.saved.commands.find(command => command.id === input.commandId);
    if (existing) {
      if (existing.digest !== digest) throw new PersonbotSettingsError(409, "This settings command was already used with different content");
      return { revision: existing.revision, duplicate: true };
    }
    if (input.expectedRevision !== this.saved.revision) {
      throw new PersonbotSettingsError(409, "Model settings changed; refresh before saving");
    }
    if (this.environment.DEEPSEEK_API_KEY?.trim() && (input.apiKey !== undefined || input.clearApiKey === true)) {
      throw new PersonbotSettingsError(409, "The API key is supplied by the server environment; change or remove it there");
    }
    if (this.saved.commands.length >= MAX_COMMANDS) {
      throw new PersonbotSettingsError(409, "The settings command history is full");
    }
    const revision = this.saved.revision + 1;
    const next: SavedSettings = {
      schema: 1,
      revision,
      model: input.model,
      ...(input.clearApiKey ? {} : input.apiKey !== undefined ? { apiKey: input.apiKey } : this.saved.apiKey ? { apiKey: this.saved.apiKey } : {}),
      commands: [...this.saved.commands, { id: input.commandId, digest, revision }],
    };
    const serialized = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) throw new PersonbotSettingsError(409, "Model settings exceed their storage budget");
    writeFileAtomic(this.file, serialized, { mode: 0o600 });
    this.saved = next;
    return { revision, duplicate: false };
  }

  private fingerprint(): string {
    const launch = this.launch();
    return hash([launch.provider, launch.model, launch.env.DEEPSEEK_API_KEY]);
  }

  private read(): SavedSettings {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error("Invalid settings file");
      const saved = JSON.parse(readFileSync(fd, "utf8")) as SavedSettings;
      if (!saved || saved.schema !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0
        || saved.model !== undefined && !MODELS.has(saved.model) && !(this.options.fixture && saved.model === (this.options.model ?? "fixture"))
        || saved.apiKey !== undefined && !usableKey(saved.apiKey)
        || !Array.isArray(saved.commands) || saved.commands.length > MAX_COMMANDS
        || saved.commands.some(command => !command || typeof command.id !== "string" || !ID.test(command.id)
          || typeof command.digest !== "string" || !/^[0-9a-f]{64}$/.test(command.digest)
          || !Number.isSafeInteger(command.revision) || command.revision <= 0 || command.revision > saved.revision)) {
        throw new Error("Invalid settings file");
      }
      fchmodSync(fd, 0o600);
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, revision: 0, commands: [] };
      throw new PersonbotSettingsError(503, "Personbot model settings could not be read");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
