import type { SettingsPatch, SettingsRecord, SettingsRepository } from '../../src/settings/types';
import { DEFAULT_SETTINGS } from '../../src/settings/types';

/** In-memory test double, same role as every other module's -- fast, no DB. Defaults match `DEFAULT_SETTINGS` exactly, which in turn match today's frozen `config.rules.*` values, so existing tests that never touch settings see unchanged behavior. */
export class InMemorySettingsRepository implements SettingsRepository {
  private record: SettingsRecord = { ...DEFAULT_SETTINGS, updatedAt: new Date(0) };

  /** Test helper: seed the record directly, as if read back after a restart. */
  seed(record: Partial<SettingsRecord>): void {
    this.record = { ...this.record, ...record };
  }

  async get(): Promise<SettingsRecord> {
    return { ...this.record };
  }

  async update(patch: SettingsPatch): Promise<SettingsRecord> {
    this.record = { ...this.record, ...patch, updatedAt: new Date() };
    return { ...this.record };
  }

  async pause(): Promise<SettingsRecord> {
    this.record = { ...this.record, paused: true, updatedAt: new Date() };
    return { ...this.record };
  }

  async resume(): Promise<SettingsRecord> {
    this.record = { ...this.record, paused: false, updatedAt: new Date() };
    return { ...this.record };
  }
}
