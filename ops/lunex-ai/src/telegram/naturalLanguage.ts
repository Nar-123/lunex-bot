import type { Priority } from '../stateStore';

export type Intent =
  | { kind: 'status' }
  | { kind: 'progress' }
  | { kind: 'continue' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'queue' }
  | { kind: 'test' }
  | { kind: 'build' }
  | { kind: 'task'; text: string; priority: Priority; allowStrategyChange: boolean };

const PRIORITY_RULES: readonly [Priority, RegExp][] = [
  ['P0', /\b(security|keamanan|secret|private[\s_-]?key|kunci privat|leak|bocor|kebocoran|vulnerab|kerentanan|data corruption|korupsi data|korup)/i],
  ['P1', /\b(exit|execution|eksekusi|transaction|transaksi|position|posisi|swap|mint|nonce|stop[\s-]?loss|take[\s-]?profit|slippage|liquidity|likuiditas)/i],
  ['P2', /\b(rpc|reliab|keandalan|state|recovery|pemulihan|crash|restart|monitor|reconcil|rekonsiliasi|bug|fix|perbaiki|failing|gagal|error)/i],
  ['P3', /\b(tests?|tes|pengujian|refactor|coverage)/i],
  ['P4', /\b(docs?|documentation|dokumentasi|readme|comment|komentar|cleanup|rapikan)/i],
];

export function inferPriority(text: string): Priority {
  for (const [priority, re] of PRIORITY_RULES) if (re.test(text)) return priority;
  return 'P2';
}

const STRATEGY_NEGATION = /(tanpa|jangan|tidak boleh|without|don'?t|do not|never|no)\s+(\w+\s+){0,2}(mengubah|ubah|merubah|change|changing|modify|modifying|alter|touch)\s+(\w+\s+){0,2}(strateg)/i;
const STRATEGY_PERMISSION = /(--allow-strategy\b|(boleh|izinkan|silakan|diizinkan)\s+(\w+\s+){0,2}(mengubah|ubah|merubah|perubahan)\s+(\w+\s+){0,2}strateg|(allow|permit|approve)\s+(\w+\s+){0,2}strategy\s+change|you may change (the )?strategy)/i;

/**
 * Strategy changes need an EXPLICIT permission phrase. Any negation
 * ("tanpa mengubah strategi", "don't change the strategy") wins, and
 * merely mentioning the strategy grants nothing.
 */
export function detectStrategyPermission(text: string): boolean {
  if (STRATEGY_NEGATION.test(text)) return false;
  return STRATEGY_PERMISSION.test(text);
}

function isShort(text: string): boolean {
  return text.length <= 60;
}

/** Deterministic (no model call): short control phrases map to commands, everything else becomes a task. */
export function classifyMessage(raw: string): Intent {
  const text = raw.trim();
  const t = text.toLowerCase().replace(/[.!?]+$/, '').trim();

  if (isShort(t)) {
    if (/^(status|apa (yang )?(sedang )?(kamu |anda )?(kerjakan|lakukan)|lagi ngapain|what are you doing|what'?s (up|going on)|sedang apa)$/.test(t)) return { kind: 'status' };
    if (/^(progress|progres|kemajuan|sampai mana)$/.test(t)) return { kind: 'progress' };
    if (/^(lanjut(kan)?|continue|terus(kan)?|resume work)((\s+(pengembangan|mengembangkan|developing|development|kerja))?(\s+lunex)?|\s+dari checkpoint terakhir|\s+from the last checkpoint)?$/.test(t)) return { kind: 'continue' };
    if (/^(pause|jeda|tahan dulu|berhenti sebentar)$/.test(t)) return { kind: 'pause' };
    if (/^(resume|lanjutkan lagi|mulai lagi)$/.test(t)) return { kind: 'resume' };
    if (/^(stop|hentikan|berhenti)$/.test(t)) return { kind: 'stop' };
    if (/^(queue|antrian|antrean|daftar tugas)$/.test(t)) return { kind: 'queue' };
    if (/^(jalankan (semua )?tes(t)?|run (the )?tests?)$/.test(t)) return { kind: 'test' };
    if (/^(build|jalankan build|run (the )?build)$/.test(t)) return { kind: 'build' };
  }

  return { kind: 'task', text, priority: inferPriority(text), allowStrategyChange: detectStrategyPermission(text) };
}
