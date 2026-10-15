// Execution_History: a capped (<=10) list of recent executions kept in
// chrome.storage.local, surfaced in the Session_Panel (Req 19).

const HISTORY_KEY = "ipaas_execution_history";
const MAX_ENTRIES = 10;

/** One recorded execution (Req 19.1). */
export interface HistoryEntry {
  messageId: string;
  status: string;
  timestamp: string; // ISO-8601 capture time
  integrationName: string;
  diagramId: string;
}

/** Returns the Execution_History, most recent first (Req 19.3). */
export async function getHistory(): Promise<HistoryEntry[]> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  const list = result?.[HISTORY_KEY];
  return Array.isArray(list) ? (list as HistoryEntry[]) : [];
}

/**
 * Prepends an entry and caps the list at MAX_ENTRIES, discarding the oldest
 * (Req 19.1, 19.2). A duplicate messageId is de-duplicated (keeps the newest).
 */
export async function addHistoryEntry(entry: HistoryEntry): Promise<void> {
  const current = await getHistory();
  const deduped = current.filter((e) => e.messageId !== entry.messageId);
  const next = [entry, ...deduped].slice(0, MAX_ENTRIES);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}
