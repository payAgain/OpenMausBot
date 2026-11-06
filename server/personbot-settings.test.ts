import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersonbotSettings, PersonbotSettingsError } from "./personbot-settings.ts";

const directories: string[] = [];
const key = "fixture-setup-secret-key-never-return";
const runtime = {
  enabled: true, state: "stopped" as const, workspace: "/fixture/workspace",
  provider: "deepseek-official", model: "deepseek-flash",
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "personbot-settings-"));
  directories.push(home);
  const options = { home, workspace: join(home, "workspace"), env };
  return {
    home, options,
    settings: new PersonbotSettings(options),
    file: join(home, "runtime", "settings.json"),
  };
}

describe("Personbot write-only model settings", () => {
  it("starts unconfigured without reading an ambient legacy credential or starting a runtime", () => {
    const { settings } = fixture({ OPENAI_API_KEY: "legacy-key", DSH_HOME: "/legacy/dsh" });
    expect(settings.snapshot({ primary: true, runtime })).toMatchObject({
      primary: true, revision: 0, provider: "deepseek-official", model: "deepseek-flash",
      credential: { configured: false, source: "missing" }, restartRequired: false,
    });
    expect(settings.launch()).toEqual({
      provider: "deepseek-official", model: "deepseek-flash", env: { DEEPSEEK_API_KEY: "" },
    });
  });

  it("persists a private key and model while exposing only presence in public snapshots and receipts", () => {
    const { settings, file, options } = fixture();
    const receipt = settings.save({ commandId: "save-first", expectedRevision: 0, model: "deepseek-v4-pro", apiKey: key });
    expect(receipt).toEqual({ revision: 1, duplicate: false });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(settings.snapshot({ primary: true, runtime })).toMatchObject({
      revision: 1, model: "deepseek-v4-pro", credential: { configured: true, source: "saved" },
    });
    expect(JSON.stringify(settings.snapshot({ primary: true, runtime }))).not.toContain(key);
    expect(JSON.stringify(receipt)).not.toContain(key);
    const restored = new PersonbotSettings(options);
    expect(restored.launch().env.DEEPSEEK_API_KEY).toBe(key);
    expect(restored.launch().model).toBe("deepseek-v4-pro");
    expect(readFileSync(file, "utf8")).toContain(key);
  });

  it("replays accepted commands before revision checks without restoring an old credential", () => {
    const { settings, options } = fixture();
    const first = { commandId: "first", expectedRevision: 0, model: "deepseek-flash", apiKey: key };
    settings.save(first);
    const next = `${key}-rotated`;
    settings.save({ commandId: "second", expectedRevision: 1, model: "deepseek-v4-pro", apiKey: next });
    const restored = new PersonbotSettings(options);
    expect(restored.save(first)).toEqual({ revision: 1, duplicate: true });
    expect(restored.launch().env.DEEPSEEK_API_KEY).toBe(next);
    expect(restored.snapshot({ primary: true, runtime }).revision).toBe(2);
    expect(() => restored.save({ ...first, apiKey: next })).toThrow(/different content/);
  });

  it("retains a key when omitted and clears it only through an explicit command", () => {
    const { settings, options } = fixture();
    settings.save({ commandId: "save", expectedRevision: 0, model: "deepseek-flash", apiKey: key });
    settings.save({ commandId: "model-only", expectedRevision: 1, model: "deepseek-v4-pro" });
    expect(settings.launch().env.DEEPSEEK_API_KEY).toBe(key);
    settings.save({ commandId: "clear", expectedRevision: 2, model: "deepseek-v4-pro", clearApiKey: true });
    const restored = new PersonbotSettings(options);
    expect(restored.launch().env.DEEPSEEK_API_KEY).toBe("");
    expect(restored.snapshot({ primary: true, runtime }).credential).toEqual({ configured: false, source: "missing" });
  });

  it("keeps environment credentials authoritative and refuses a misleading saved override", () => {
    const { settings, file } = fixture({ DEEPSEEK_API_KEY: ` ${key} ` });
    expect(settings.launch().env.DEEPSEEK_API_KEY).toBe(key);
    expect(settings.snapshot({ primary: true, runtime }).credential).toEqual({ configured: true, source: "environment" });
    expect(() => settings.save({ commandId: "override", expectedRevision: 0, model: "deepseek-flash", apiKey: `${key}-other` })).toThrow(/environment/);
    expect(() => settings.save({ commandId: "clear", expectedRevision: 0, model: "deepseek-flash", clearApiKey: true })).toThrow(/environment/);
    expect(() => readFileSync(file)).toThrow();
    settings.save({ commandId: "model", expectedRevision: 0, model: "deepseek-v4-pro" });
    expect(readFileSync(file, "utf8")).not.toContain(key);
  });

  it("marks saved changes as pending restart only for an already launched runtime", () => {
    const { settings } = fixture();
    settings.save({ commandId: "first", expectedRevision: 0, model: "deepseek-flash", apiKey: key });
    settings.applied();
    settings.save({ commandId: "second", expectedRevision: 1, model: "deepseek-v4-pro" });
    expect(settings.snapshot({ primary: true, runtime: { ...runtime, state: "ready" } }).restartRequired).toBe(true);
    expect(settings.snapshot({ primary: true, runtime: { ...runtime, state: "failed" } }).restartRequired).toBe(false);
    settings.applied();
    expect(settings.snapshot({ primary: true, runtime: { ...runtime, state: "ready" } }).restartRequired).toBe(false);
  });

  it("keeps a settings change pending when an earlier launch finishes afterward", () => {
    const { settings } = fixture();
    settings.save({ commandId: "first", expectedRevision: 0, model: "deepseek-flash", apiKey: key });
    const launching = settings.launch();
    settings.save({ commandId: "second", expectedRevision: 1, model: "deepseek-v4-pro" });
    settings.applied(launching);
    expect(settings.snapshot({ primary: true, runtime: { ...runtime, state: "ready" } }).restartRequired).toBe(true);
  });

  it("rejects invalid input and conflicting revisions atomically with sanitized errors", () => {
    const { settings, file } = fixture();
    const valid = { commandId: "valid", expectedRevision: 0, model: "deepseek-flash" };
    for (const input of [
      null, [], { ...valid, provider: "injected" }, { ...valid, expectedRevision: -1 },
      { ...valid, model: "unknown" }, { ...valid, apiKey: "short" },
      { ...valid, apiKey: key, clearApiKey: true }, { ...valid, clearApiKey: "yes" },
      { ...valid, apiKey: `${key}\n` }, { ...valid, commandId: "bad id" },
    ]) {
      let failure: unknown;
      try { settings.save(input); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(PersonbotSettingsError);
      expect(String(failure)).not.toContain(key);
    }
    expect(() => readFileSync(file)).toThrow();
    settings.save(valid);
    expect(() => settings.save({ ...valid, commandId: "stale" })).toThrow(/changed/);
    expect(settings.snapshot({ primary: true, runtime }).revision).toBe(1);
  });

  it("refuses corrupt or symlinked settings and narrows an existing regular file's permissions", () => {
    const first = fixture();
    first.settings.save({ commandId: "save", expectedRevision: 0, model: "deepseek-flash", apiKey: key });
    chmodSync(first.file, 0o644);
    new PersonbotSettings(first.options);
    expect(statSync(first.file).mode & 0o777).toBe(0o600);
    writeFileSync(first.file, JSON.stringify({ schema: 9, apiKey: key }));
    expect(() => new PersonbotSettings(first.options)).toThrow("Personbot model settings could not be read");
    const second = fixture();
    symlinkSync(first.file, second.file);
    expect(() => new PersonbotSettings(second.options)).toThrow("Personbot model settings could not be read");
    expect(statSync(first.file).mode & 0o777).toBe(0o600);
  });
});
