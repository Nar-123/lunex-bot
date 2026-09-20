import type { EntryState, EntryTransition, SettingsPatch, SettingsRecord, SettingsRepository } from '../../src/settings/types';
import { DEFAULT_SETTINGS, toEntryState } from '../../src/settings/types';

/** In-memory test double, same role as every other module's -- fast, no DB. Defaults match `DEFAULT_SETTINGS` exactly, which in turn match today's frozen `config.rules.*` values, so existing tests that never touch settings see unchanged behavior. */
export class InMemorySettingsRepository implements SettingsRepository {
  private record: SettingsRecord = { ...DEFAULT_SETTINGS, aiEntryPaused: false, aiEntryChangedAt: null, aiEntryRequestId: null, updatedAt: new Date(0) };

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

  async getEntryState(): Promise<EntryState> {
    return toEntryState(this.record);
  }

  async aiPauseEntry(requestId: string): Promise<EntryTransition> {
    return this.aiSet(true, requestId);
  }

  async aiResumeEntry(requestId: string): Promise<EntryTransition> {
    return this.aiSet(false, requestId);
  }

  /** Synchronous compare-and-set (mirrors the Prisma conditional UPDATE): atomic within the event loop. */
  private aiSet(target: boolean, requestId: string): EntryTransition {
    const previous = toEntryState(this.record);
    if (this.record.aiEntryPaused === target) return { changed: false, previous, current: previous };
    this.record = { ...this.record, aiEntryPaused: target, aiEntryChangedAt: new Date(), aiEntryRequestId: requestId, updatedAt: new Date() };
    return { changed: true, previous, current: toEntryState(this.record) };
  }
}
