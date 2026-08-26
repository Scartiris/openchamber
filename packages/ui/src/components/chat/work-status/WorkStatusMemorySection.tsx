import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

type MemoryEntryKind = 'write' | 'read';

interface MemoryToolEntry {
  id: string;
  kind: MemoryEntryKind;
  /** Title for writes, query/domain text for reads. */
  label: string;
}

const WRITE_ACTIONS = new Set(['remember', 'put', 'patch']);
const READ_ACTIONS = new Set(['recall', 'context', 'recover', 'get']);

const normalizeAction = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const readString = (source: Record<string, unknown> | undefined, ...keys: string[]): string => {
  if (!source) return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
};

/**
 * Personal-memory activity (pigeon_* tools) in this session: what was written
 * and what was recalled. Distinct from the "agent memory" count, which tracks
 * AGENTS.md files.
 */
export const WorkStatusMemorySection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const messages = useSessionMessageRecords(sessionId ?? '', directory ?? undefined);

  const entries = React.useMemo<MemoryToolEntry[]>(() => {
    const list: MemoryToolEntry[] = [];
    for (const record of messages) {
      for (const part of record.parts) {
        if (part.type !== 'tool') continue;
        const toolPart = part as ToolPartType;
        const toolName = String(toolPart.tool || '').toLowerCase();
        if (!toolName.startsWith('pigeon_')) continue;

        const state = (toolPart.state ?? {}) as {
          input?: Record<string, unknown>;
          status?: string;
          title?: string;
        };
        const input = state.input ?? {};
        const action = normalizeAction(input.action);
        const kind: MemoryEntryKind = WRITE_ACTIONS.has(action)
          ? 'write'
          : READ_ACTIONS.has(action)
            ? 'read'
            : action
              ? 'write'
              : 'read';

        const label =
          (kind === 'write' ? readString(input, 'title') : '')
          || readString(input, 'query')
          || (kind === 'write' ? readString(input, 'body').split('\n')[0] : '')
          || readString(input, 'domain', 'type', 'id')
          || (state.title ?? '');

        list.push({
          id: `${record.info.id}:${toolPart.id ?? toolPart.callID ?? list.length}`,
          kind,
          label: label.length > 80 ? `${label.slice(0, 80)}…` : label,
        });
      }
    }
    // Newest first so the panel mirrors the chat timeline direction.
    return [...list].reverse();
  }, [messages]);

  const writeCount = entries.filter((entry) => entry.kind === 'write').length;
  const readCount = entries.length - writeCount;

  useReportWorkStatusPresence('memoryTools', entries.length > 0);

  if (entries.length === 0) {
    return null;
  }

  const summaryParts: string[] = [];
  if (writeCount > 0) summaryParts.push(t('chat.workStatus.memory.written', { count: writeCount }));
  if (readCount > 0) summaryParts.push(t('chat.workStatus.memory.readCount', { count: readCount }));

  return (
    <WorkStatusCollapsibleSection
      id="memory-tools"
      title={t('chat.workStatus.section.memoryTools')}
      icon="brain-ai-3"
      summary={summaryParts.join(' · ')}
      defaultExpanded={false}
    >
      {entries.map((entry) => (
        <WorkStatusRow
          key={entry.id}
          muted
          leading={(
            <Icon
              name="brain-ai-3"
              className={entry.kind === 'write' ? 'size-4 shrink-0' : 'size-4 shrink-0 opacity-60'}
            />
          )}
          label={entry.label || t('chat.workStatus.memory.unnamed')}
          value={(
            <WorkStatusValue tone="muted">
              {entry.kind === 'write'
                ? t('chat.workStatus.memory.actionWrite')
                : t('chat.workStatus.memory.actionRead')}
            </WorkStatusValue>
          )}
        />
      ))}
    </WorkStatusCollapsibleSection>
  );
};
